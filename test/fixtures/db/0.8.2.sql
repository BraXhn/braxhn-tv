-- fixtur: {"version":"0.8.2","rev":"8559d53","user":"anna","password":"Uppgradering-Test-2026!","appToken":"4409f42bb9eed75150dd43b96f09a981326577df39ee5a00fc413959d7055772"}
-- Skapad av test/fixtures/db/make.mjs med BraXhn TV 0.8.2 – redigera inte för hand.
BEGIN;
CREATE TABLE users(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE NOT NULL,
  pass TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, totp_secret TEXT, totp_pending TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last INTEGER NOT NULL DEFAULT 0, recovery TEXT, remote_allowed INTEGER NOT NULL DEFAULT 1, pw_changed INTEGER, parent_id INTEGER, pin TEXT, max_age INTEGER, color TEXT, screen_time TEXT, notify_personal TEXT, offline_sync TEXT);
INSERT INTO "users"("id","name","pass","is_admin","created","totp_secret","totp_pending","totp_enabled","totp_last","recovery","remote_allowed","pw_changed","parent_id","pin","max_age","color","screen_time","notify_personal","offline_sync") VALUES(1,'anna','s2:07e194a765de2eb25b2e3eec9a7dde3a:1437f1592ca764586490519f8582480732af3dcbc66855251ebb4fbdc9c8e014700b3be6cb27e8c38d304bdac8f315b144596afca17d98039fb16b54565db38c',1,1792843758,NULL,NULL,0,0,NULL,1,1792843758,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "users"("id","name","pass","is_admin","created","totp_secret","totp_pending","totp_enabled","totp_last","recovery","remote_allowed","pw_changed","parent_id","pin","max_age","color","screen_time","notify_personal","offline_sync") VALUES(2,'Bertil','s2:07e194a765de2eb25b2e3eec9a7dde3a:1437f1592ca764586490519f8582480732af3dcbc66855251ebb4fbdc9c8e014700b3be6cb27e8c38d304bdac8f315b144596afca17d98039fb16b54565db38c',0,1760000000,NULL,NULL,0,0,NULL,0,NULL,NULL,NULL,NULL,'#3a7',NULL,NULL,NULL);
INSERT INTO "users"("id","name","pass","is_admin","created","totp_secret","totp_pending","totp_enabled","totp_last","recovery","remote_allowed","pw_changed","parent_id","pin","max_age","color","screen_time","notify_personal","offline_sync") VALUES(3,'Lilla Ö','s2:07e194a765de2eb25b2e3eec9a7dde3a:1437f1592ca764586490519f8582480732af3dcbc66855251ebb4fbdc9c8e014700b3be6cb27e8c38d304bdac8f315b144596afca17d98039fb16b54565db38c',0,1760000000,NULL,NULL,0,0,NULL,1,NULL,1,NULL,7,'#e55','{"daily":60}',NULL,NULL);
CREATE TABLE sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'web', expires INTEGER, scope_item INTEGER, ua TEXT, ip TEXT, last_seen INTEGER, remember INTEGER NOT NULL DEFAULT 1);
INSERT INTO "sessions"("token","user_id","created","kind","expires","scope_item","ua","ip","last_seen","remember") VALUES('3e3cd076aa261a726c0dabcd04e71a6fb0cd997fc10c859a2a7d6aa65e8a7819',1,1792843758,'web',1795435758,NULL,'node','127.0.0.1',1792843758,1);
INSERT INTO "sessions"("token","user_id","created","kind","expires","scope_item","ua","ip","last_seen","remember") VALUES('23ab8ca2293415c2635d37c6255c3a02ad4f91be98fd879f373ce075aed6009b',1,1792843758,'app',1824379758,NULL,'node','127.0.0.1',1792843758,1);
CREATE TABLE items(
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('movie','show','episode')),
  parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  title TEXT NOT NULL, sort_title TEXT, year INTEGER, season INTEGER, episode INTEGER,
  path TEXT, size INTEGER, mtime INTEGER, duration REAL, container TEXT,
  vcodec TEXT, acodec TEXT, width INTEGER, height INTEGER, streams TEXT,
  overview TEXT, rating REAL, tmdb_id INTEGER, meta_done INTEGER NOT NULL DEFAULT 0,
  poster INTEGER NOT NULL DEFAULT 0, backdrop INTEGER NOT NULL DEFAULT 0, thumb INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL, intro_start REAL, intro_end REAL, credits_start REAL, markers_done INTEGER NOT NULL DEFAULT 0, hdr TEXT, genres TEXT, recap_start REAL, recap_end REAL, trickplay INTEGER NOT NULL DEFAULT 0, cert TEXT, age INTEGER, collection_id INTEGER, match_locked INTEGER NOT NULL DEFAULT 0, abs_episode INTEGER, sub_auto INTEGER NOT NULL DEFAULT 0, chapters TEXT, src_name TEXT, credits_done INTEGER NOT NULL DEFAULT 0, trailer_yt TEXT, version_of INTEGER REFERENCES items(id) ON DELETE SET NULL, ep_guess INTEGER NOT NULL DEFAULT 0);
INSERT INTO "items"("id","library_id","kind","parent_id","title","sort_title","year","season","episode","path","size","mtime","duration","container","vcodec","acodec","width","height","streams","overview","rating","tmdb_id","meta_done","poster","backdrop","thumb","added","intro_start","intro_end","credits_start","markers_done","hdr","genres","recap_start","recap_end","trickplay","cert","age","collection_id","match_locked","abs_episode","sub_auto","chapters","src_name","credits_done","trailer_yt","version_of","ep_guess") VALUES(1,1,'movie',NULL,'Fönstret mot gården','fonstret mot garden',1954,NULL,NULL,'/finns-inte/Filmer/Fönstret (1954).mkv',1000,1760000000,6720.5,'matroska','h264','ac3',1920,1080,'[{"type":"video","codec":"h264"}]','En fotograf med gipsat ben – "Jeff" – ser något han inte borde.
Rad två.',8.3,567,1,0,0,0,1760000000,NULL,NULL,NULL,0,NULL,'["Thriller"]',NULL,NULL,0,'11',11,1,0,NULL,0,'[{"t":0,"n":"Början"}]',NULL,0,NULL,NULL,0);
INSERT INTO "items"("id","library_id","kind","parent_id","title","sort_title","year","season","episode","path","size","mtime","duration","container","vcodec","acodec","width","height","streams","overview","rating","tmdb_id","meta_done","poster","backdrop","thumb","added","intro_start","intro_end","credits_start","markers_done","hdr","genres","recap_start","recap_end","trickplay","cert","age","collection_id","match_locked","abs_episode","sub_auto","chapters","src_name","credits_done","trailer_yt","version_of","ep_guess") VALUES(2,1,'movie',NULL,'Bröderna Lejonhjärta',NULL,1977,NULL,NULL,'/finns-inte/Filmer/Bröderna (1977).mp4',1000,1760000000,6480,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,11034,1,0,0,0,1760000000,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,0,'7',7,1,0,NULL,0,NULL,NULL,0,NULL,NULL,0);
INSERT INTO "items"("id","library_id","kind","parent_id","title","sort_title","year","season","episode","path","size","mtime","duration","container","vcodec","acodec","width","height","streams","overview","rating","tmdb_id","meta_done","poster","backdrop","thumb","added","intro_start","intro_end","credits_start","markers_done","hdr","genres","recap_start","recap_end","trickplay","cert","age","collection_id","match_locked","abs_episode","sub_auto","chapters","src_name","credits_done","trailer_yt","version_of","ep_guess") VALUES(3,1,'movie',NULL,'Bröderna Lejonhjärta',NULL,1977,NULL,NULL,'/finns-inte/Filmer/Bröderna (1977) 4K.mkv',1000,1760000000,6480,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,0,0,0,1760000000,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,0,NULL,0,NULL,NULL,0,NULL,2,0);
INSERT INTO "items"("id","library_id","kind","parent_id","title","sort_title","year","season","episode","path","size","mtime","duration","container","vcodec","acodec","width","height","streams","overview","rating","tmdb_id","meta_done","poster","backdrop","thumb","added","intro_start","intro_end","credits_start","markers_done","hdr","genres","recap_start","recap_end","trickplay","cert","age","collection_id","match_locked","abs_episode","sub_auto","chapters","src_name","credits_done","trailer_yt","version_of","ep_guess") VALUES(4,2,'show',NULL,'Serien',NULL,2020,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,999,1,0,0,0,1760000000,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,0,NULL,0,NULL,'Serien',0,NULL,NULL,0);
INSERT INTO "items"("id","library_id","kind","parent_id","title","sort_title","year","season","episode","path","size","mtime","duration","container","vcodec","acodec","width","height","streams","overview","rating","tmdb_id","meta_done","poster","backdrop","thumb","added","intro_start","intro_end","credits_start","markers_done","hdr","genres","recap_start","recap_end","trickplay","cert","age","collection_id","match_locked","abs_episode","sub_auto","chapters","src_name","credits_done","trailer_yt","version_of","ep_guess") VALUES(5,2,'episode',4,'Avsnitt 1',NULL,NULL,1,1,'/finns-inte/Serier/Serien/Season 1/Serien S01E01.mkv',NULL,1760000000,1500,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,0,0,1760000001,15,45,1400,1,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,0,NULL,0,NULL,NULL,0,NULL,NULL,0);
INSERT INTO "items"("id","library_id","kind","parent_id","title","sort_title","year","season","episode","path","size","mtime","duration","container","vcodec","acodec","width","height","streams","overview","rating","tmdb_id","meta_done","poster","backdrop","thumb","added","intro_start","intro_end","credits_start","markers_done","hdr","genres","recap_start","recap_end","trickplay","cert","age","collection_id","match_locked","abs_episode","sub_auto","chapters","src_name","credits_done","trailer_yt","version_of","ep_guess") VALUES(6,2,'episode',4,'Avsnitt 2',NULL,NULL,1,2,'/finns-inte/Serier/Serien/Season 1/Serien S01E02.mkv',NULL,1760000000,1500,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,0,0,1760000002,15,45,1400,1,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,0,NULL,0,NULL,NULL,0,NULL,NULL,0);
INSERT INTO "items"("id","library_id","kind","parent_id","title","sort_title","year","season","episode","path","size","mtime","duration","container","vcodec","acodec","width","height","streams","overview","rating","tmdb_id","meta_done","poster","backdrop","thumb","added","intro_start","intro_end","credits_start","markers_done","hdr","genres","recap_start","recap_end","trickplay","cert","age","collection_id","match_locked","abs_episode","sub_auto","chapters","src_name","credits_done","trailer_yt","version_of","ep_guess") VALUES(7,2,'episode',4,'Avsnitt 3',NULL,NULL,1,3,'/finns-inte/Serier/Serien/Season 1/Serien S01E03.mkv',NULL,1760000000,1500,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,0,0,1760000003,15,45,1400,1,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,0,NULL,0,NULL,NULL,0,NULL,NULL,0);
CREATE TABLE progress(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0, duration REAL, watched INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL, PRIMARY KEY(user_id,item_id));
INSERT INTO "progress"("user_id","item_id","position","duration","watched","updated") VALUES(1,1,1234.5,1500,0,1760000001);
INSERT INTO "progress"("user_id","item_id","position","duration","watched","updated") VALUES(1,5,1500,1500,1,1760000005);
INSERT INTO "progress"("user_id","item_id","position","duration","watched","updated") VALUES(1,6,300.25,1500,0,1760000006);
INSERT INTO "progress"("user_id","item_id","position","duration","watched","updated") VALUES(3,2,60,1500,0,1760000002);
CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT);
INSERT INTO "settings"("k","v") VALUES('app_version','0.8.2');
INSERT INTO "settings"("k","v") VALUES('scan_interval','120');
INSERT INTO "settings"("k","v") VALUES('public_url','https://tv.exempel.se');
INSERT INTO "settings"("k","v") VALUES('lang','sv');
INSERT INTO "settings"("k","v") VALUES('tmdb_key','');
CREATE TABLE audit(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id INTEGER, user_name TEXT,
  ip TEXT, event TEXT NOT NULL, detail TEXT);
INSERT INTO "audit"("id","ts","user_id","user_name","ip","event","detail") VALUES(1,1792843758,1,'anna','127.0.0.1','setup',NULL);
INSERT INTO "audit"("id","ts","user_id","user_name","ip","event","detail") VALUES(2,1792843758,1,'anna','127.0.0.1','login_ok','app');
CREATE TABLE collections(id INTEGER PRIMARY KEY, name TEXT NOT NULL, overview TEXT,
  poster INTEGER NOT NULL DEFAULT 0, backdrop INTEGER NOT NULL DEFAULT 0);
INSERT INTO "collections"("id","name","overview","poster","backdrop") VALUES(1,'Samlingen','Två filmer',0,0);
CREATE TABLE watchlist(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, added INTEGER NOT NULL, PRIMARY KEY(user_id,item_id));
INSERT INTO "watchlist"("user_id","item_id","added") VALUES(1,2,1760000000);
CREATE TABLE artists(id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sort_name TEXT);
INSERT INTO "artists"("id","library_id","name","sort_name") VALUES(1,3,'Artisten','artisten');
CREATE TABLE albums(id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL, title TEXT NOT NULL, sort_title TEXT, year INTEGER, genre TEXT,
  cover INTEGER NOT NULL DEFAULT 0, dir TEXT, added INTEGER NOT NULL);
INSERT INTO "albums"("id","library_id","artist_id","title","sort_title","year","genre","cover","dir","added") VALUES(1,3,1,'Skivan',NULL,1999,'Pop',0,'/finns-inte/Musik/Skivan',1760000000);
CREATE TABLE tracks(id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  album_id INTEGER REFERENCES albums(id) ON DELETE CASCADE, artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  title TEXT NOT NULL, track_no INTEGER, disc_no INTEGER, duration REAL, path TEXT NOT NULL, size INTEGER, mtime INTEGER,
  codec TEXT, bitrate INTEGER, sample_rate INTEGER, channels INTEGER, added INTEGER NOT NULL, rg_track REAL, rg_album REAL, rg_peak REAL, loudness TEXT);
INSERT INTO "tracks"("id","library_id","album_id","artist_id","title","track_no","disc_no","duration","path","size","mtime","codec","bitrate","sample_rate","channels","added","rg_track","rg_album","rg_peak","loudness") VALUES(1,3,1,1,'Låt 1',1,1,200,'/finns-inte/Musik/Skivan/01.flac',100,1760000000,'flac',NULL,NULL,NULL,1760000000,-6.5,NULL,NULL,NULL);
INSERT INTO "tracks"("id","library_id","album_id","artist_id","title","track_no","disc_no","duration","path","size","mtime","codec","bitrate","sample_rate","channels","added","rg_track","rg_album","rg_peak","loudness") VALUES(2,3,1,1,'Låt 2',2,1,200,'/finns-inte/Musik/Skivan/02.flac',100,1760000000,'flac',NULL,NULL,NULL,1760000000,-6.5,NULL,NULL,NULL);
CREATE TABLE playlists(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, created INTEGER NOT NULL);
INSERT INTO "playlists"("id","user_id","name","created") VALUES(1,1,'Favoriter',1760000000);
CREATE TABLE playlist_items(playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, pos INTEGER NOT NULL);
INSERT INTO "playlist_items"("playlist_id","track_id","pos") VALUES(1,1,0);
INSERT INTO "playlist_items"("playlist_id","track_id","pos") VALUES(1,2,1);
CREATE TABLE track_plays(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, ts INTEGER NOT NULL);
INSERT INTO "track_plays"("user_id","track_id","ts") VALUES(1,1,1760000000);
CREATE TABLE favorites(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, PRIMARY KEY(user_id, track_id));
INSERT INTO "favorites"("user_id","track_id") VALUES(1,2);
CREATE TABLE "libraries"(id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN('movie','show','music','audiobook')), path TEXT NOT NULL,
      anime INTEGER NOT NULL DEFAULT 0);
INSERT INTO "libraries"("id","name","type","path","anime") VALUES(1,'Filmer','movie','/finns-inte/braxhn-uppgradering/Filmer',0);
INSERT INTO "libraries"("id","name","type","path","anime") VALUES(2,'Serier','show','/finns-inte/braxhn-uppgradering/Serier',0);
INSERT INTO "libraries"("id","name","type","path","anime") VALUES(3,'Musik','music','/finns-inte/braxhn-uppgradering/Musik',0);
INSERT INTO "libraries"("id","name","type","path","anime") VALUES(4,'Ljudböcker','audiobook','/finns-inte/braxhn-uppgradering/Ljudböcker',0);
CREATE TABLE continue_hidden(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, at INTEGER NOT NULL, PRIMARY KEY(user_id,item_id));
INSERT INTO "continue_hidden"("user_id","item_id","at") VALUES(1,4,1760000000);
CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL, profile_path TEXT, bio TEXT,
  birthday TEXT, deathday TEXT, birthplace TEXT, bio_fetched INTEGER NOT NULL DEFAULT 0);
INSERT INTO "people"("id","name","profile_path","bio","birthday","deathday","birthplace","bio_fetched") VALUES(4070,'Grace Kelly',NULL,NULL,NULL,NULL,NULL,0);
CREATE TABLE item_people(item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, role TEXT NOT NULL, character TEXT, ord INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(item_id, role, person_id));
INSERT INTO "item_people"("item_id","person_id","role","character","ord") VALUES(1,4070,'cast','Lisa',0);
CREATE TABLE trailers(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE, path TEXT NOT NULL UNIQUE, size INTEGER, mtime INTEGER, added INTEGER NOT NULL);
CREATE TABLE plays(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, item_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  mode TEXT, remote INTEGER, device TEXT);
INSERT INTO "plays"("id","user_id","item_id","ts","mode","remote","device") VALUES(1,1,1,1760000000,'remux',0,'Webb');
CREATE TABLE listen_prefs(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  normalize INTEGER NOT NULL DEFAULT 1, skip_back INTEGER NOT NULL DEFAULT 15, skip_fwd INTEGER NOT NULL DEFAULT 30,
  skip_silence INTEGER NOT NULL DEFAULT 0, updated INTEGER);
CREATE TABLE requests(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, user_name TEXT,
  kind TEXT NOT NULL CHECK(kind IN('movie','show')), tmdb_id INTEGER NOT NULL, title TEXT NOT NULL, year INTEGER, poster TEXT, overview TEXT,
  status TEXT NOT NULL DEFAULT 'pending', note TEXT, created INTEGER NOT NULL, updated INTEGER);
CREATE TABLE books(id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  key TEXT NOT NULL, title TEXT NOT NULL, sort_title TEXT, author TEXT, narrator TEXT, series TEXT, year INTEGER, description TEXT,
  cover INTEGER NOT NULL DEFAULT 0, duration REAL, chapters TEXT, added INTEGER NOT NULL);
INSERT INTO "books"("id","library_id","key","title","sort_title","author","narrator","series","year","description","cover","duration","chapters","added") VALUES(1,4,'boken','Boken',NULL,'Författaren',NULL,NULL,NULL,NULL,0,36000,NULL,1760000000);
CREATE TABLE book_files(id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  path TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT, duration REAL, offset REAL NOT NULL DEFAULT 0, size INTEGER, mtime INTEGER, codec TEXT, bitrate INTEGER);
INSERT INTO "book_files"("id","book_id","path","idx","title","duration","offset","size","mtime","codec","bitrate") VALUES(1,1,'/finns-inte/Ljudböcker/Boken/01.mp3',0,NULL,36000,0,NULL,NULL,NULL,NULL);
CREATE TABLE book_progress(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0, speed REAL, updated INTEGER NOT NULL, PRIMARY KEY(user_id, book_id));
INSERT INTO "book_progress"("user_id","book_id","position","finished","speed","updated") VALUES(1,1,4321,0,NULL,1760000000);
CREATE TABLE bookmarks(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE, position REAL NOT NULL, note TEXT, created INTEGER NOT NULL);
INSERT INTO "bookmarks"("id","user_id","book_id","position","note","created") VALUES(1,1,1,100,'Här',1760000000);
CREATE TABLE book_probe_fail(path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER);
CREATE TABLE podcasts(id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT, author TEXT, description TEXT, link TEXT,
  image INTEGER NOT NULL DEFAULT 0, added_by INTEGER, keep INTEGER NOT NULL DEFAULT 3, last_fetch INTEGER, error TEXT, added INTEGER NOT NULL);
INSERT INTO "podcasts"("id","url","title","author","description","link","image","added_by","keep","last_fetch","error","added") VALUES(1,'https://exempel.se/pod.xml','Podden',NULL,NULL,NULL,0,1,3,NULL,NULL,1760000000);
CREATE TABLE podcast_episodes(id INTEGER PRIMARY KEY, podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  guid TEXT NOT NULL, title TEXT, description TEXT, published INTEGER, duration REAL, url TEXT NOT NULL, mime TEXT, size INTEGER,
  file TEXT, downloading INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL);
INSERT INTO "podcast_episodes"("id","podcast_id","guid","title","description","published","duration","url","mime","size","file","downloading","added") VALUES(1,1,'ep1','Första',NULL,1760000000,1800,'https://exempel.se/1.mp3',NULL,NULL,NULL,0,1760000000);
CREATE TABLE podcast_progress(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, episode_id INTEGER NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0, played INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL, PRIMARY KEY(user_id, episode_id));
INSERT INTO "podcast_progress"("user_id","episode_id","position","played","updated") VALUES(1,1,900,0,1760000000);
CREATE TABLE follows(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, active INTEGER NOT NULL DEFAULT 1, auto INTEGER NOT NULL DEFAULT 0,
  sync INTEGER, added INTEGER NOT NULL, PRIMARY KEY(user_id, show_id));
INSERT INTO "follows"("user_id","show_id","active","auto","sync","added") VALUES(1,4,1,0,NULL,1760000000);
CREATE TABLE new_episodes(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, season INTEGER NOT NULL, episode INTEGER NOT NULL,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL, added INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, show_id, season, episode));
INSERT INTO "new_episodes"("user_id","show_id","season","episode","item_id","added","seen") VALUES(1,4,1,3,7,1760000000,0);
CREATE TABLE screen_usage(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL, seconds REAL NOT NULL DEFAULT 0, extra INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day));
CREATE TABLE passkeys(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, name TEXT, created INTEGER NOT NULL, last_used INTEGER);
CREATE TABLE tuners(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('hdhr','m3u')), name TEXT NOT NULL, url TEXT NOT NULL,
  epg_url TEXT, tuner_count INTEGER NOT NULL DEFAULT 2, device_auth TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_refresh INTEGER, error TEXT);
CREATE TABLE channels(id INTEGER PRIMARY KEY, tuner_id INTEGER NOT NULL REFERENCES tuners(id) ON DELETE CASCADE,
  number TEXT, name TEXT NOT NULL, logo TEXT, stream_url TEXT NOT NULL, epg_id TEXT, group_name TEXT, hd INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0, sort REAL);
CREATE TABLE programs(id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  start INTEGER NOT NULL, stop INTEGER NOT NULL, title TEXT NOT NULL, subtitle TEXT, description TEXT, category TEXT,
  season INTEGER, episode INTEGER, icon TEXT, is_new INTEGER NOT NULL DEFAULT 0);
CREATE TABLE rec_commercials(recording_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
  segments TEXT, error TEXT, updated INTEGER);
CREATE TABLE dvr_rules(id INTEGER PRIMARY KEY, title TEXT NOT NULL, channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  new_only INTEGER NOT NULL DEFAULT 1, keep INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created INTEGER NOT NULL);
CREATE TABLE recordings(id INTEGER PRIMARY KEY, channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL, channel_name TEXT,
  program_id INTEGER, rule_id INTEGER REFERENCES dvr_rules(id) ON DELETE SET NULL, title TEXT NOT NULL, subtitle TEXT, description TEXT,
  season INTEGER, episode INTEGER, start INTEGER NOT NULL, stop INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
  file TEXT, size INTEGER, duration REAL, error TEXT, created_by INTEGER, created INTEGER NOT NULL);
CREATE TABLE trakt(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, access TEXT NOT NULL, refresh TEXT,
  expires INTEGER, username TEXT, last_sync INTEGER, sync_error TEXT);
CREATE TABLE watch_cache(kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, data TEXT, fetched INTEGER NOT NULL, PRIMARY KEY(kind, tmdb_id));
CREATE INDEX items_lib ON items(library_id, kind);
CREATE INDEX items_path ON items(path);
CREATE INDEX audit_ts ON audit(ts);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX items_coll ON items(collection_id);
CREATE UNIQUE INDEX artists_name ON artists(library_id, name COLLATE NOCASE);
CREATE INDEX albums_artist ON albums(artist_id);
CREATE INDEX tracks_album ON tracks(album_id, disc_no, track_no);
CREATE INDEX tracks_path ON tracks(path);
CREATE INDEX pli ON playlist_items(playlist_id, pos);
CREATE INDEX tp_user ON track_plays(user_id, ts);
CREATE INDEX items_version ON items(version_of);
CREATE INDEX items_lib_added ON items(library_id, kind, added);
CREATE INDEX items_lib_sort ON items(library_id, kind, sort_title);
CREATE INDEX items_parent_se ON items(parent_id, season, episode);
CREATE INDEX items_tmdb ON items(tmdb_id);
CREATE INDEX items_kind_added ON items(kind, added);
CREATE INDEX items_src ON items(library_id, kind, src_name COLLATE NOCASE);
CREATE INDEX progress_item ON progress(item_id);
CREATE INDEX watchlist_item ON watchlist(item_id);
CREATE INDEX tp_track ON track_plays(track_id);
CREATE INDEX fav_track ON favorites(track_id);
CREATE INDEX pli_track ON playlist_items(track_id);
CREATE INDEX sessions_expires ON sessions(expires);
CREATE INDEX people_name ON people(name COLLATE NOCASE);
CREATE INDEX item_people_person ON item_people(person_id);
CREATE INDEX trailers_item ON trailers(item_id);
CREATE INDEX plays_ts ON plays(ts);
CREATE INDEX plays_user ON plays(user_id, ts);
CREATE UNIQUE INDEX requests_tmdb ON requests(kind, tmdb_id);
CREATE UNIQUE INDEX books_key ON books(library_id, key);
CREATE INDEX book_files_book ON book_files(book_id, idx);
CREATE UNIQUE INDEX pe_guid ON podcast_episodes(podcast_id, guid);
CREATE INDEX pe_pub ON podcast_episodes(podcast_id, published DESC);
CREATE INDEX follows_show ON follows(show_id, active);
CREATE INDEX new_ep_user ON new_episodes(user_id, seen, added);
CREATE INDEX new_ep_item ON new_episodes(item_id);
CREATE INDEX passkeys_user ON passkeys(user_id);
CREATE UNIQUE INDEX channels_url ON channels(tuner_id, stream_url);
CREATE INDEX programs_ch ON programs(channel_id, start);
CREATE INDEX programs_title ON programs(title COLLATE NOCASE, start);
CREATE INDEX rec_start ON recordings(status, start);
PRAGMA user_version=5;
COMMIT;
