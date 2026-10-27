import type { Knex } from 'knex';

/*
 * Model servers beyond Ollama (037_model_servers): B-4302 and B-4304, Sprint 35a.
 *
 * - `instances.kind`: `ollama` (the default, every existing row) or `openai`, a Chat Completions server such as
 *   Apple's `fm serve`, `mlx_lm.server` or llama.cpp's `llama-server`. `socket_path` is a Unix socket the server
 *   listens on instead of a TCP port (the URL is then only the HTTP origin sent in requests). `token_ref` is a
 *   `vault:<path>#<key>` reference to the bearer token, resolved under the vault policy of `token_owner` in
 *   `token_tenant` (pools and instances are shared by every tenant; the token lives in the tenant of whoever saved it).
 * - `models.server_instance_id` and `server_model`: a catalogue entry held by a server rather than pulled
 *   (`format` `server`, no expected digest): the instance it was registered from and the server's model id.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('instances', (t) => {
    t.string('kind', 20).notNullable().defaultTo('ollama');
    t.string('socket_path', 300).nullable();
    t.string('token_ref', 500).nullable();
    t.string('token_tenant', 26).nullable();
    t.string('token_owner', 26).nullable();
  });
  await knex.schema.alterTable('models', (t) => {
    t.string('server_instance_id', 26).nullable();
    t.string('server_model', 200).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('models', (t) => {
    t.dropColumn('server_model');
    t.dropColumn('server_instance_id');
  });
  await knex.schema.alterTable('instances', (t) => {
    t.dropColumn('token_owner');
    t.dropColumn('token_tenant');
    t.dropColumn('token_ref');
    t.dropColumn('socket_path');
    t.dropColumn('kind');
  });
}
