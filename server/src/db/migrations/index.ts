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
import * as m042 from './042_research_tools.js';
import * as m043 from './043_knowledge_categories.js';
import * as m044 from './044_knowledge_changes.js';
import * as m045 from './045_knowledge_revisions.js';
import * as m046 from './046_classifier_categories.js';
import * as m047 from './047_files_read.js';
import * as m048 from './048_net_and_file_tools.js';
import * as m049 from './049_allowed_host_tools.js';
import * as m050 from './050_dataset_import.js';
import * as m051 from './051_chat_capabilities.js';
import * as m052 from './052_knowledge_index_versions.js';
import * as m053 from './053_net_diagnostics.js';
import * as m054 from './054_model_thinking_templates.js';
import * as m056 from './056_guardrail_rule_drafts.js';
import * as m057 from './057_held_writes.js';
import * as m058 from './058_moderation_queue_agents.js';
import * as m059 from './059_evidence_holds.js';
import * as m060 from './060_vault_system_scope.js';
import * as m061 from './061_apikey_leases.js';
import * as m062 from './062_group_profiles_notices.js';
import * as m063 from './063_reference_owners_group_bans.js';
import * as m064 from './064_group_cases_conversations.js';
import * as m065 from './065_group_roles_event_extras.js';
import * as m066 from './066_credential_leases.js';
import * as m067 from './067_signing_key_registry.js';
import * as m068 from './068_credential_refs.js';
import * as m069 from './069_group_access_subjects.js';
import * as m070 from './070_response_cache.js';
import * as m071 from './071_user_dids.js';
import * as m072 from './072_plugin_surfaces.js';
import * as m073 from './073_feed_crosspost.js';
import * as m074 from './074_image_tools.js';
import * as m075 from './075_image_tool_schemas.js';
import * as m076 from './076_chat_folders.js';
import * as m077 from './077_dm_folders.js';
import * as m079 from './079_lowcode_port.js';
import * as m080 from './080_app_views.js';
import * as m082 from './082_app_flow_integration.js';
import * as m083 from './083_platform_app_import.js';
import * as m084 from './084_profile_preferences.js';
import * as m085 from './085_workflow_hooks.js';
import * as m086 from './086_workflow_retention.js';
import * as m087 from './087_decision_tables.js';
import * as m088 from './088_approval_deadlines.js';
import * as m089 from './089_sla_routing.js';
import * as m090 from './090_saved_queries.js';
import * as m091 from './091_rest_connections.js';
import * as m092 from './092_app_import.js';
import * as m093 from './093_app_record_links.js';
import * as m094 from './094_workflow_templates.js';
import * as m095 from './095_workflow_analytics_indexes.js';
import * as m096 from './096_workflow_schedule_timezone.js';
import * as m097 from './097_designer_editing.js';
import * as m098 from './098_design_locks.js';
import * as m099 from './099_file_meta.js';
import * as m100 from './100_app_charts.js';
import * as m101 from './101_app_dashboards.js';
import * as m102 from './102_app_reports.js';
import * as m103 from './103_app_exports.js';
import * as m104 from './104_app_subscriptions.js';
import * as m105 from './105_app_roles.js';
import * as m106 from './106_credential_use_limits.js';
import * as m107 from './107_security_scans.js';
import * as m108 from './108_vault_seal.js';
import * as m109 from './109_plugin_drafts.js';
import * as m110 from './110_overview_prefs.js';
import * as m111 from './111_knowledge_feedback_tree.js';
import * as m112 from './112_file_documents.js';
import * as m113 from './113_file_locations.js';
import * as m114 from './114_connection_engines.js';
import * as m115 from './115_push_devices.js';
import * as m116 from './116_notification_preferences.js';
import * as m117 from './117_push_providers.js';
import * as m118 from './118_push_deliveries.js';
import * as m119 from './119_guardrail_tests.js';
import * as m120 from './120_guardrail_term_lists.js';
import * as m121 from './121_file_queries.js';
import * as m122 from './122_spam_signals.js';
import * as m123 from './123_spam_responses.js';
import * as m124 from './124_billing_plans_subscriptions.js';
import * as m125 from './125_billing_cycles_tiers.js';
import * as m126 from './126_billing_discounts.js';
import * as m127 from './127_pki_settings.js';
import * as m128 from './128_ca_tokens.js';
import * as m129 from './129_signin_policy.js';
import * as m130 from './130_oidc_client_settings.js';
import * as m131 from './131_leaked_password_lists.js';
import * as m132 from './132_notification_templates.js';
import * as m133 from './133_group_proposals.js';
import * as m134 from './134_group_votes.js';
import * as m135 from './135_albums.js';
import * as m136 from './136_album_links.js';
import * as m137 from './137_feature_flags.js';
import * as m138 from './138_search_index.js';
import * as m139 from './139_search_state.js';
import * as m140 from './140_identity_store_state.js';
import * as m141 from './141_identity_store_backups.js';
import * as m142 from './142_identity_store_governance.js';
import * as m143 from './143_directory_sync_state.js';
import * as m144 from './144_knowledge_document_creator.js';
import * as m145 from './145_saved_searches.js';
import * as m146 from './146_cloud_accounts.js';
import * as m147 from './147_cloud_federation.js';
import * as m148 from './148_cloud_journal.js';
import * as m149 from './149_cloud_lifecycle.js';
import * as m150 from './150_cloud_prices.js';
import * as m151 from './151_cloud_releases.js';
import * as m152 from './152_cloud_budgets.js';
import * as m153 from './153_cloud_databases.js';
import * as m155 from './155_cloud_costs.js';
import * as m156 from './156_cloud_connections.js';
import * as m157 from './157_cloud_gpu_pools.js';
import * as m158 from './158_cloud_autoscale.js';
import * as m159 from './159_cloud_models.js';
import * as m160 from './160_cloud_model_servers.js';
import * as m161 from './161_cloud_edge.js';
import * as m163 from './163_cloud_model_prices.js';
import * as m164 from './164_cloud_showback.js';
import * as m165 from './165_cloud_change_trail.js';
import * as m166 from './166_cloud_anomalies.js';
import * as m167 from './167_cloud_sandbox_flag.js';
import * as m168 from './168_widen_session_refs.js';
import * as m169 from './169_connection_admin_accounts.js';
import * as m170 from './170_doc_sites.js';

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
  '042_research_tools': m042,
  '043_knowledge_categories': m043,
  '044_knowledge_changes': m044,
  '045_knowledge_revisions': m045,
  '046_classifier_categories': m046,
  '047_files_read': m047,
  '048_net_and_file_tools': m048,
  '049_allowed_host_tools': m049,
  '050_dataset_import': m050,
  '051_chat_capabilities': m051,
  '052_knowledge_index_versions': m052,
  '053_net_diagnostics': m053,
  '054_model_thinking_templates': m054,
  '056_guardrail_rule_drafts': m056,
  '057_held_writes': m057,
  '058_moderation_queue_agents': m058,
  '059_evidence_holds': m059,
  '060_vault_system_scope': m060,
  '061_apikey_leases': m061,
  '062_group_profiles_notices': m062,
  '063_reference_owners_group_bans': m063,
  '064_group_cases_conversations': m064,
  '065_group_roles_event_extras': m065,
  '066_credential_leases': m066,
  '067_signing_key_registry': m067,
  '068_credential_refs': m068,
  '069_group_access_subjects': m069,
  '070_response_cache': m070,
  '071_user_dids': m071,
  '072_plugin_surfaces': m072,
  '073_feed_crosspost': m073,
  '074_image_tools': m074,
  '075_image_tool_schemas': m075,
  '076_chat_folders': m076,
  '077_dm_folders': m077,
  '079_lowcode_port': m079,
  '080_app_views': m080,
  '082_app_flow_integration': m082,
  '083_platform_app_import': m083,
  '084_profile_preferences': m084,
  '085_workflow_hooks': m085,
  '086_workflow_retention': m086,
  '087_decision_tables': m087,
  '088_approval_deadlines': m088,
  '089_sla_routing': m089,
  '090_saved_queries': m090,
  '091_rest_connections': m091,
  '092_app_import': m092,
  '093_app_record_links': m093,
  '094_workflow_templates': m094,
  '095_workflow_analytics_indexes': m095,
  '096_workflow_schedule_timezone': m096,
  '097_designer_editing': m097,
  '098_design_locks': m098,
  '099_file_meta': m099,
  '100_app_charts': m100,
  '101_app_dashboards': m101,
  '102_app_reports': m102,
  '103_app_exports': m103,
  '104_app_subscriptions': m104,
  '105_app_roles': m105,
  '106_credential_use_limits': m106,
  '107_security_scans': m107,
  '108_vault_seal': m108,
  '109_plugin_drafts': m109,
  '110_overview_prefs': m110,
  '111_knowledge_feedback_tree': m111,
  '112_file_documents': m112,
  '113_file_locations': m113,
  '114_connection_engines': m114,
  '115_push_devices': m115,
  '116_notification_preferences': m116,
  '117_push_providers': m117,
  '118_push_deliveries': m118,
  '119_guardrail_tests': m119,
  '120_guardrail_term_lists': m120,
  '121_file_queries': m121,
  '122_spam_signals': m122,
  '123_spam_responses': m123,
  '124_billing_plans_subscriptions': m124,
  '125_billing_cycles_tiers': m125,
  '126_billing_discounts': m126,
  '127_pki_settings': m127,
  '128_ca_tokens': m128,
  '129_signin_policy': m129,
  '130_oidc_client_settings': m130,
  '131_leaked_password_lists': m131,
  '132_notification_templates': m132,
  '133_group_proposals': m133,
  '134_group_votes': m134,
  '135_albums': m135,
  '136_album_links': m136,
  '137_feature_flags': m137,
  '138_search_index': m138,
  '139_search_state': m139,
  '140_identity_store_state': m140,
  '141_identity_store_backups': m141,
  '142_identity_store_governance': m142,
  '143_directory_sync_state': m143,
  '144_knowledge_document_creator': m144,
  '145_saved_searches': m145,
  '146_cloud_accounts': m146,
  '147_cloud_federation': m147,
  '148_cloud_journal': m148,
  '149_cloud_lifecycle': m149,
  '150_cloud_prices': m150,
  '151_cloud_releases': m151,
  '152_cloud_budgets': m152,
  '153_cloud_databases': m153,
  '155_cloud_costs': m155,
  '156_cloud_connections': m156,
  '157_cloud_gpu_pools': m157,
  '158_cloud_autoscale': m158,
  '159_cloud_models': m159,
  '160_cloud_model_servers': m160,
  '161_cloud_edge': m161,
  '163_cloud_model_prices': m163,
  '164_cloud_showback': m164,
  '165_cloud_change_trail': m165,
  '166_cloud_anomalies': m166,
  '167_cloud_sandbox_flag': m167,
  '168_widen_session_refs': m168,
  '169_connection_admin_accounts': m169,
  '170_doc_sites': m170
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
