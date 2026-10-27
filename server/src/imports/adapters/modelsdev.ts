import { SourceError, type CatalogItem } from '../types.js';
import { join, str, uniq, type AdapterContext, type RepositoryAdapter } from './types.js';

/*
 * Models.dev (https://models.dev): an open, community catalogue of AI models and their metadata. One request to
 * `/api.json` returns every provider and, under each, its models with capabilities (reasoning, tool calling,
 * structured output), modalities, context and output limits, cost, release and update dates, and whether the model's
 * weights are open. It serves no weights, so this is a browse-and-compare catalogue, not an import source
 * (`modelImport: false`, like InvenioRDM's model kind): the snapshot and its facets are the value, and the full
 * record for each model is kept so the select view can show it.
 */

interface MdModel {
  id?: string;
  name?: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  release_date?: string;
  last_updated?: string;
  modalities?: { input?: string[]; output?: string[] };
  open_weights?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  status?: string;
  cost?: { input?: number; output?: number; cache_read?: number };
}
interface MdProvider {
  id?: string;
  name?: string;
  doc?: string;
  npm?: string;
  models?: Record<string, MdModel>;
}

const apiUrl = (base: string) => join(base || 'https://models.dev', 'api.json');

async function catalogue(ctx: AdapterContext): Promise<Record<string, MdProvider>> {
  const { body } = await ctx.fetcher.json<Record<string, MdProvider>>(apiUrl(ctx.repo.baseUrl), ctx.access, { signal: ctx.signal });
  if (!body || typeof body !== 'object') throw new SourceError('Models.dev did not return the catalogue JSON.');
  return body;
}

const modalities = (m: MdModel): string[] => uniq([...(m.modalities?.input ?? []).map((x) => `in:${x}`), ...(m.modalities?.output ?? []).map((x) => `out:${x}`)]);

/** The capability tags a model advertises, used as the classification facet so a browse can filter on them. */
function capabilities(m: MdModel): string[] {
  const caps: string[] = [];
  if (m.reasoning) caps.push('Reasoning');
  if (m.tool_call) caps.push('Tool calling');
  if (m.structured_output) caps.push('Structured output');
  if (m.attachment) caps.push('Attachments');
  if ((m.modalities?.input ?? []).some((x) => x === 'image')) caps.push('Vision');
  if ((m.modalities?.input ?? []).some((x) => x === 'audio')) caps.push('Audio');
  return caps.length ? caps : ['Text'];
}

function toItem(providerId: string, provider: MdProvider, modelKey: string, m: MdModel): CatalogItem {
  const publisher = str(provider.name) ?? providerId;
  const name = str(m.name) ?? str(m.id) ?? modelKey;
  const access = m.open_weights ? 'Open weights' : 'API only';
  const ctxWindow = typeof m.limit?.context === 'number' ? m.limit.context : null;
  return {
    kind: 'model',
    itemId: `${providerId}/${str(m.id) ?? modelKey}`,
    name,
    publisher,
    description: str(m.description),
    classification: str(m.family),
    licence: null,
    formats: ['metadata'],
    gated: m.open_weights === false,
    sizeBytes: null,
    updated: str(m.last_updated) ?? str(m.release_date),
    facets: {
      access: [access],
      library: [publisher],
      ...(m.family ? { family: [str(m.family)!] } : {}),
      classification: capabilities(m),
      format: ['metadata']
    },
    data: {
      provider: { id: providerId, name: publisher, doc: str(provider.doc), npm: str(provider.npm) },
      model: m,
      modalities: modalities(m),
      capabilities: capabilities(m),
      contextTokens: ctxWindow,
      openWeights: m.open_weights === true,
      status: str(m.status)
    }
  };
}

export const modelsdevAdapter: RepositoryAdapter = {
  async probe(ctx: AdapterContext): Promise<string> {
    const cat = await catalogue(ctx);
    const providers = Object.keys(cat).length;
    let models = 0;
    for (const p of Object.values(cat)) models += Object.keys(p.models ?? {}).length;
    return `${providers} providers, ${models} models`;
  },
  async *harvest(ctx: AdapterContext): AsyncIterable<CatalogItem> {
    const cat = await catalogue(ctx);
    for (const [providerId, provider] of Object.entries(cat)) {
      for (const [modelKey, m] of Object.entries(provider.models ?? {})) {
        if (!m || typeof m !== 'object') continue;
        yield toItem(providerId, provider, modelKey, m);
      }
    }
  }
};
