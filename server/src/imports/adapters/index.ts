import type { RepoType } from '../types.js';
import { bundleAdapter } from './bundle.js';
import { estatAdapter, ogdAdapter } from './dataset-sources.js';
import { ckanAdapter, dcatAdapter, invenioAdapter, kaggleAdapter, openmlAdapter, sdmxAdapter } from './datasets.js';
import { hfAdapter } from './hf.js';
import { modelsdevAdapter } from './modelsdev.js';
import { ollamaAdapter } from './ollama.js';
import type { RepositoryAdapter } from './types.js';

export const ADAPTERS: Record<RepoType, RepositoryAdapter> = {
  hf: hfAdapter,
  ollama: ollamaAdapter,
  modelsdev: modelsdevAdapter,
  ckan: ckanAdapter,
  dcat: dcatAdapter,
  sdmx: sdmxAdapter,
  openml: openmlAdapter,
  invenio: invenioAdapter,
  kaggle: kaggleAdapter,
  estat: estatAdapter,
  ogd: ogdAdapter,
  bundle: bundleAdapter
};

export type { AdapterContext, RepositoryAdapter } from './types.js';
