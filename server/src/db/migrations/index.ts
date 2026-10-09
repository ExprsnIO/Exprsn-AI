import type { Knex } from 'knex';
import * as m001 from './001_core.js';
import * as m002 from './002_tenancy_platform.js';
import * as m003 from './003_gateway.js';
import * as m004 from './004_chat.js';
import * as m006 from './006_knowledge.js';
import * as m005 from './005_guardrails.js';
import * as m007 from './007_registry.js';
import * as m008 from './008_workflows.js';
import * as m009 from './009_training.js';
import * as m010 from './010_zones.js';
import * as m011 from './011_platform_ops.js';
import * as m012 from './012_federation.js';
import * as m013 from './013_account.js';
import * as m014 from './014_chat_hold.js';
import * as m015 from './015_integrations.js';
import * as m016 from './016_federation2.js';
import * as m017 from './017_ops.js';
import * as m018 from './018_chat_depth.js';
import * as m019 from './019_identity3.js';
import * as m020 from './020_platform3.js';
import * as m021 from './021_integrations2.js';
import * as m022 from './022_keys.js';
import * as m023 from './023_ai.js';
import * as m024 from './024_ops2.js';
import * as m025 from './025_integrations3.js';
import * as m026 from './026_pki_secrets.js';
import * as m026b from './026b_secrets.js';
import * as m026c from './026c_core.js';
import * as m027 from './027_acme.js';
import * as m027b from './027b_atproto.js';
import * as m027c from './027c_leases.js';
import * as m027d from './027d_plugins.js';
import * as m028 from './028_identity.js';
import * as m028b from './028b_atproto_accounts.js';
import * as m028d from './028d_files.js';
import * as m029 from './029_apps.js';
import * as m029b from './029b_firehose.js';
import * as m028c from './028c_moderation.js';
import * as m029c from './029c_groups.js';
import * as m030 from './030_channels.js';
import * as m030b from './030b_social.js';
import * as m030c from './030c_feed.js';
import * as m031 from './031_access.js';
import * as m031b from './031b_record_queries.js';
import * as m032 from './032_dav.js';
import * as m032c from './032c_memory.js';
import * as m033 from './033_pds.js';
import * as m033b from './033b_feeds.js';
import * as m033c from './033c_imports.js';
import * as m034 from './034_workflows2.js';
import * as m034b from './034b_workflow_triggers.js';
import * as m034c from './034c_workflow_steps.js';
import * as m036 from './036_chains.js';
import * as m036b from './036b_profiles.js';
import * as m036c from './036c_dav_files.js';
import * as m037 from './037_model_servers.js';
import * as m037b from './037b_platform_ops.js';
import * as m037c from './037c_platform_storage.js';
import * as m037d from './037d_platform_social.js';
import * as m038 from './038_groups2.js';
import * as m038b from './038b_dedup_held_vault.js';
import * as m038c from './038c_knowledge_images.js';
import * as m039 from './039_tools_injection.js';
import * as m039b from './039b_mcp_server.js';
import * as m039c from './039c_scim_vault_posts.js';
import * as m040 from './040_inventory_analytics.js';
import * as m040b from './040b_redteam_agents.js';
import * as m040c from './040c_policies_dlp.js';
import * as m041 from './041_provenance_artifacts.js';
import * as m041b from './041b_app_packages.js';
import * as m041c from './041c_model_gen_sync.js';
import * as m041d from './041d_entity_api_embeds.js';
import * as m041e from './041e_thinking_templates.js';
import * as m042 from './042_chat_invocation.js';
import * as m042b from './042b_dataset_import.js';
import * as m043 from './043_mcp_standing_approvals.js';

interface Migration {
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

// Migrations are imported, not discovered on disk, so the same list works from src (tsx) and dist (node).
const MIGRATIONS: Record<string, Migration> = {
  '001_core': m001,
  '002_tenancy_platform': m002,
  '003_gateway': m003,
  '004_chat': m004,
  '005_guardrails': m005,
  '006_knowledge': m006,
  '007_registry': m007,
  '008_workflows': m008,
  '009_training': m009,
  '010_zones': m010,
  '011_platform_ops': m011,
  '012_federation': m012,
  '013_account': m013,
  '014_chat_hold': m014,
  '015_integrations': m015,
  '016_federation2': m016,
  '017_ops': m017,
  '018_chat_depth': m018,
  '019_identity3': m019,
  '020_platform3': m020,
  '021_integrations2': m021,
  '022_keys': m022,
  '023_ai': m023,
  '024_ops2': m024,
  '025_integrations3': m025,
  '026_pki_secrets': m026,
  '026b_secrets': m026b,
  '026c_core': m026c,
  '027_acme': m027,
  '027b_atproto': m027b,
  '027c_leases': m027c,
  '027d_plugins': m027d,
  '028_identity': m028,
  '028b_atproto_accounts': m028b,
  '028c_moderation': m028c,
  '028d_files': m028d,
  '029_apps': m029,
  '029b_firehose': m029b,
  '029c_groups': m029c,
  '030_channels': m030,
  '030b_social': m030b,
  '030c_feed': m030c,
  '031_access': m031,
  '031b_record_queries': m031b,
  '032_dav': m032,
  '032c_memory': m032c,
  '033_pds': m033,
  '033b_feeds': m033b,
  '033c_imports': m033c,
  '034_workflows2': m034,
  '034b_workflow_triggers': m034b,
  '034c_workflow_steps': m034c,
  '036_chains': m036,
  '036b_profiles': m036b,
  '036c_dav_files': m036c,
  '037_model_servers': m037,
  '037b_platform_ops': m037b,
  '037c_platform_storage': m037c,
  '037d_platform_social': m037d,
  '038_groups2': m038,
  '038b_dedup_held_vault': m038b,
  '038c_knowledge_images': m038c,
  '039_tools_injection': m039,
  '039b_mcp_server': m039b,
  '039c_scim_vault_posts': m039c,
  '040_inventory_analytics': m040,
  '040b_redteam_agents': m040b,
  '040c_policies_dlp': m040c,
  '041_provenance_artifacts': m041,
  '041b_app_packages': m041b,
  '041c_model_gen_sync': m041c,
  '041d_entity_api_embeds': m041d,
  '041e_thinking_templates': m041e,
  '042_chat_invocation': m042,
  '042b_dataset_import': m042b,
  '043_mcp_standing_approvals': m043
};

export const migrationSource: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(MIGRATIONS).sort(),
  getMigrationName: (name) => name,
  getMigration: async (name) => {
    const m = MIGRATIONS[name];
    if (!m) throw new Error(`Unknown migration ${name}`);
    return m;
  }
};
