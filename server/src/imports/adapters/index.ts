import type { RepoType } from '../types.js';
import { bundleAdapter } from './bundle.js';
import { ckanAdapter, dcatAdapter, invenioAdapter, kaggleAdapter, openmlAdapter, sdmxAdapter } from './datasets.js';
import { hfAdapter } from './hf.js';
import { ollamaAdapter } from './ollama.js';
import type { RepositoryAdapter } from './types.js';

export const ADAPTERS: Record<RepoType, RepositoryAdapter> = {
  hf: hfAdapter,
  ollama: ollamaAdapter,
  ckan: ckanAdapter,
  dcat: dcatAdapter,
  sdmx: sdmxAdapter,
  openml: openmlAdapter,
  invenio: invenioAdapter,
  kaggle: kaggleAdapter,
  bundle: bundleAdapter
};

export type { AdapterContext, DatasetDetail, RepositoryAdapter } from './types.js';
