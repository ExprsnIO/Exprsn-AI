# Import fixtures

Parquet files for `server/test/sprint40-dataset-sources.test.ts`, written with pyarrow 25 (the test suite has no
Parquet writer). `readings.snappy.parquet` has 250 rows in three row groups (Snappy, dictionary pages);
`readings.zstd.parquet` and `readings.gzip.parquet` hold its first 20 rows (the gzip one with version 2 data pages and
no dictionary). Columns: `id` (int64), `station`, `reading` (double, one null), `valid` (bool), `taken` (timestamp,
UTC), `big` (int64, the first past 2^53), `tags` (list of strings), `note` (one row holds an email address).
