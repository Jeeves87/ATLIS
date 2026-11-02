// webtorrent ships no TypeScript types; torrents.ts casts the instance to its
// own minimal structural interfaces (WtClient/WtTorrent) covering what we use.
declare module 'webtorrent' {
  const WebTorrent: new (opts?: Record<string, unknown>) => unknown
  export default WebTorrent
}
