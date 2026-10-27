import type { Services } from '../services.js';
import { ChatSearch } from './chats.js';
import { SearchEverything } from './everything.js';
import { SearchIndex } from './indexer.js';
import { PostSearch } from './posts.js';
import { IndexReader } from './query.js';
import { SavedSearches } from './saved.js';

/*
 * 1.9.0, Sprint 52 (B-170 to B-173): `s.search`. `index` is the blind index (keys, writes, backfill, rotation and its
 * administration), `chats` and `posts` the searches of B-171 and B-172, `everything` the one search box of B-173.
 * `saved` the saved searches (1.9.9-qa). `init` registers the jobs and the write listeners; both do nothing for a tenant that has not turned the index on.
 */
export class SearchService {
  readonly index: SearchIndex;
  readonly reader: IndexReader;
  readonly chats: ChatSearch;
  readonly posts: PostSearch;
  readonly everything: SearchEverything;
  readonly saved: SavedSearches;
  private started = false;

  constructor(s: () => Services) {
    this.index = new SearchIndex(s);
    this.reader = new IndexReader(() => s().db, this.index.keys);
    this.chats = new ChatSearch(s, this.index, this.reader);
    this.posts = new PostSearch(s, this.index, this.reader);
    this.everything = new SearchEverything(s, this.chats, this.posts);
    this.saved = new SavedSearches(s);
  }

  init(): void {
    if (this.started) return;
    this.started = true;
    this.index.registerJobs();
    this.index.listen();
  }
}
