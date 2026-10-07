import type { Knex } from 'knex';

/*
 * Distance filters for groups and events (B-4403). A point is WGS 84 latitude and longitude in degrees. The database
 * narrows the candidates (PostGIS `ST_DWithin` on a geography when PostgreSQL has the extension, a bounding box on the
 * latitude and longitude columns elsewhere) and `distanceKm` decides, so the three databases return the same rows: the
 * PostGIS search radius is widened by a small margin and the exact cut is always this module's great-circle distance
 * on the sphere PostGIS itself uses for `use_spheroid => false`.
 */

/** The mean Earth radius in km that PostGIS uses for sphere calculations. */
export const EARTH_RADIUS_KM = 6371.0087714;
/** The largest radius a filter may ask for (half the circumference: everything). */
export const MAX_RADIUS_KM = 20_016;

export interface Point {
  lat: number;
  lon: number;
}

export interface Near extends Point {
  km: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance (haversine) in km. */
export function distanceKm(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const validPoint = (p: { lat?: number | null; lon?: number | null }): p is Point =>
  typeof p.lat === 'number' && typeof p.lon === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

/**
 * The bounding box around a circle: latitudes, and the longitude ranges (two when it crosses the antimeridian, none
 * when it reaches a pole, where every longitude is in).
 */
export function boundingBox(c: Near): { minLat: number; maxLat: number; lon: [number, number][] | null } {
  const dLat = (c.km / EARTH_RADIUS_KM) * (180 / Math.PI);
  const minLat = c.lat - dLat;
  const maxLat = c.lat + dLat;
  if (minLat <= -90 || maxLat >= 90) return { minLat: Math.max(-90, minLat), maxLat: Math.min(90, maxLat), lon: null };
  // The widest longitude span of the circle (at the latitude where it touches the box's sides).
  const dLon = Math.asin(Math.min(1, Math.sin(c.km / EARTH_RADIUS_KM) / Math.cos(rad(c.lat)))) * (180 / Math.PI);
  const lo = c.lon - dLon;
  const hi = c.lon + dLon;
  if (dLon >= 180) return { minLat, maxLat, lon: null };
  if (lo < -180) return { minLat, maxLat, lon: [[lo + 360, 180], [-180, hi]] };
  if (hi > 180) return { minLat, maxLat, lon: [[lo, 180], [-180, hi - 360]] };
  return { minLat, maxLat, lon: [[lo, hi]] };
}

/** Whether PostGIS is installed in this PostgreSQL database (asked once per process and database). */
const postgis = new WeakMap<object, Promise<boolean>>();
export function hasPostgis(db: Knex): Promise<boolean> {
  if (db.client.config.client !== 'pg') return Promise.resolve(false);
  let p = postgis.get(db.client as object);
  if (!p) {
    p = db
      .raw("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS on")
      .then((r: { rows: { on: boolean }[] }) => !!r.rows[0]?.on)
      .catch(() => false);
    postgis.set(db.client as object, p);
  }
  return p;
}

/**
 * Narrows a query on a table with `lat` and `lon` columns (aliased `alias`) to the candidates near `c`. The caller
 * keeps the rows whose `distanceKm` is at most `c.km`.
 */
export async function narrow(db: Knex, qb: Knex.QueryBuilder, alias: string, c: Near): Promise<'postgis' | 'box'> {
  const col = (n: string) => `${alias}.${n}`;
  qb.whereNotNull(col('lat')).whereNotNull(col('lon'));
  if (await hasPostgis(db)) {
    // The same expression as the GiST index of 038_groups2, so the index is used.
    qb.whereRaw(`ST_DWithin(ST_SetSRID(ST_MakePoint(??, ??), 4326)::geography, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?, false)`, [col('lon'), col('lat'), c.lon, c.lat, c.km * 1000 * 1.001 + 10]);
    return 'postgis';
  }
  // A margin of 0.1 % keeps rounding on the boundary inside the box; the exact cut is the caller's.
  const b = boundingBox({ ...c, km: c.km * 1.001 + 0.01 });
  qb.whereBetween(col('lat'), [b.minLat, b.maxLat]);
  if (b.lon) {
    const ranges = b.lon;
    qb.andWhere((w) => {
      for (const [lo, hi] of ranges) void w.orWhereBetween(col('lon'), [lo, hi]);
    });
  }
  return 'box';
}

/** Parses `near=<lat>,<lon>` with a radius into a filter, or null. */
export function parseNear(near: string | undefined, km: number | undefined): Near | null {
  if (!near) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(near);
  if (!m) return null;
  const p = { lat: Number(m[1]), lon: Number(m[2]) };
  if (!validPoint(p)) return null;
  return { ...p, km: Math.min(MAX_RADIUS_KM, Math.max(0.001, km ?? 25)) };
}
