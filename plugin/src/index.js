'use strict';

const browse = require('./browse.js');
const media = require('./media.js');
const lyrics = require('./lyrics.js');
const home = require('./home.js');
const auth = require('./auth.js');

module.exports = {
  search: browse.search,
  searchBest: browse.searchBest,
  album: browse.album,
  playlist: browse.playlist,
  artist: browse.artist,
  artistAlbums: browse.artistAlbums,
  artistMvs: browse.artistMvs,
  mvStream: media.mvStream,
  stream: media.stream,
  lyrics: lyrics.lyrics,
  lyricsSearch: lyrics.lyricsSearch,
  lyricsFetch: lyrics.lyricsFetch,
  home: home.home,
  library: home.library,
  like: home.like,
  account: auth.account,
  login: auth.login,
};
