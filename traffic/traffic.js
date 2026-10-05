// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Traffic Analyzer. Reads the output of MONITOR from Redis or Valkey and
// reports what the traffic is made of: commands per second, the command mix,
// reads against writes, the busiest keys, key patterns and clients, how the
// keys would spread over a cluster, commands worth a second look, and an LRU
// hit-rate curve that says how many keys a cache needs to hold for a given
// hit rate. One file, no dependencies. In a browser it defines KVTraffic; in
// Node, require() returns the same functions.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KVTraffic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  const strictDecoder = new TextDecoder('utf-8', { fatal: true });

  // ---- Commands ----

  // Every command and subcommand of Valkey 9.1.2 and Redis 8.10.2, from
  // COMMAND: name, arity, first key, last key, key step, and flags:
  // w write, r read-only, a admin, p pub/sub, m keys found by position rules,
  // d dangerous, b blocking, s slow, x scripting.
  const COMMAND_TABLE = [
    'ACL -2 0 0 0 s;ACL|CAT -2 0 0 0 s;ACL|DELUSER -3 0 0 0 ads;ACL|DRYRUN -4 0 0 0 ads;ACL|GENPASS -2 0 0 0 s',
    'ACL|GETUSER 3 0 0 0 ads;ACL|HELP 2 0 0 0 s;ACL|LIST 2 0 0 0 ads;ACL|LOAD 2 0 0 0 ads;ACL|LOG -2 0 0 0 ads',
    'ACL|SAVE 2 0 0 0 ads;ACL|SETUSER -3 0 0 0 ads;ACL|USERS 2 0 0 0 ads;ACL|WHOAMI 2 0 0 0 s;APPEND 3 1 1 1 w',
    'ARCOUNT 2 1 1 1 r;ARDEL -3 1 1 1 w;ARDELRANGE -4 1 1 1 ws;ARGET 3 1 1 1 r;ARGETRANGE 4 1 1 1 rs',
    'ARGREP -6 1 1 1 rs;ARINFO -2 1 1 1 rs;ARINSERT -3 1 1 1 w;ARLASTITEMS -3 1 1 1 rs;ARLEN 2 1 1 1 r',
    'ARMGET -3 1 1 1 r;ARMSET -4 1 1 1 w;ARNEXT 2 1 1 1 r;AROP -5 1 1 1 rs;ARRING -4 1 1 1 ws;ARSCAN -4 1 1 1 rs',
    'ARSEEK 3 1 1 1 w;ARSET -4 1 1 1 w;ASKING 1 0 0 0 ;AUTH -2 0 0 0 ;BACKUP 2 0 0 0 s;BACKUP|ABORT 2 0 0 0 ads',
    'BACKUP|CLEANUP 2 0 0 0 ads;BACKUP|HELP 2 0 0 0 s;BACKUP|LIST 2 0 0 0 ads;BACKUP|SEAL 2 0 0 0 ads',
    'BACKUP|START 2 0 0 0 ads;BACKUP|STATUS 2 0 0 0 ads;BGREWRITEAOF 1 0 0 0 ads;BGSAVE -1 0 0 0 ads',
    'BITCOUNT -2 1 1 1 rs;BITFIELD -2 1 1 1 ws;BITFIELD_RO -2 1 1 1 r;BITOP -4 2 -1 1 ws;BITPOS -3 1 1 1 rs',
    'BLMOVE 6 1 2 1 wbs;BLMOVEM -6 1 2 1 wbs;BLMPOP -5 0 0 0 wmbs;BLPOP -3 1 -2 1 wbs;BRPOP -3 1 -2 1 wbs',
    'BRPOPLPUSH 4 1 2 1 wbs;BZMPOP -5 0 0 0 wmbs;BZPOPMAX -3 1 -2 1 wb;BZPOPMIN -3 1 -2 1 wb;CLIENT -2 0 0 0 s',
    'CLIENT|CACHING 3 0 0 0 s;CLIENT|CAPA -3 0 0 0 s;CLIENT|GETNAME 2 0 0 0 s;CLIENT|GETREDIR 2 0 0 0 s',
    'CLIENT|HELP 2 0 0 0 s;CLIENT|ID 2 0 0 0 s;CLIENT|IMPORT-SOURCE 3 0 0 0 s;CLIENT|INFO 2 0 0 0 s',
    'CLIENT|KILL -3 0 0 0 ads;CLIENT|LIST -2 0 0 0 ads;CLIENT|NO-EVICT 3 0 0 0 ads;CLIENT|NO-TOUCH 3 0 0 0 s',
    'CLIENT|PAUSE -3 0 0 0 ads;CLIENT|REPLY 3 0 0 0 s;CLIENT|SETINFO 4 0 0 0 s;CLIENT|SETNAME 3 0 0 0 s',
    'CLIENT|TRACKING -3 0 0 0 s;CLIENT|TRACKINGINFO 2 0 0 0 s;CLIENT|UNBLOCK -3 0 0 0 ads',
    'CLIENT|UNPAUSE 2 0 0 0 ads;CLUSTER -2 0 0 0 s;CLUSTER|ADDSLOTS -3 0 0 0 ads',
    'CLUSTER|ADDSLOTSRANGE -4 0 0 0 ads;CLUSTER|BUMPEPOCH 2 0 0 0 ads;CLUSTER|CANCELSLOTMIGRATIONS 2 0 0 0 ads',
    'CLUSTER|COUNT-FAILURE-REPORTS 3 0 0 0 ads;CLUSTER|COUNTKEYSINSLOT 3 0 0 0 s;CLUSTER|DELSLOTS -3 0 0 0 ads',
    'CLUSTER|DELSLOTSRANGE -4 0 0 0 ads;CLUSTER|FAILOVER -2 0 0 0 ads;CLUSTER|FLUSHSLOT -3 0 0 0 wads',
    'CLUSTER|FLUSHSLOTS 2 0 0 0 ads;CLUSTER|FORGET 3 0 0 0 ads;CLUSTER|GETKEYSINSLOT 4 0 0 0 s',
    'CLUSTER|GETSLOTMIGRATIONS 2 0 0 0 ads;CLUSTER|HELP 2 0 0 0 s;CLUSTER|INFO 2 0 0 0 s',
    'CLUSTER|KEYSLOT 3 0 0 0 s;CLUSTER|LINKS 2 0 0 0 s;CLUSTER|MEET -4 0 0 0 ads',
    'CLUSTER|MIGRATESLOTS -4 0 0 0 ads;CLUSTER|MIGRATION -4 0 0 0 ads;CLUSTER|MYID 2 0 0 0 s',
    'CLUSTER|MYSHARDID 2 0 0 0 s;CLUSTER|NODES 2 0 0 0 s;CLUSTER|REPLICAS 3 0 0 0 ads',
    'CLUSTER|REPLICATE -3 0 0 0 ads;CLUSTER|RESET -2 0 0 0 ads;CLUSTER|SAVECONFIG 2 0 0 0 ads',
    'CLUSTER|SET-CONFIG-EPOCH 3 0 0 0 ads;CLUSTER|SETSLOT -4 0 0 0 ads;CLUSTER|SHARDS 2 0 0 0 s',
    'CLUSTER|SLAVES 3 0 0 0 ads;CLUSTER|SLOT-STATS -4 0 0 0 s;CLUSTER|SLOTS 2 0 0 0 s',
    'CLUSTER|SYNCSLOTS -3 0 0 0 ads;CLUSTERSCAN -2 1 1 1 rs;COMMAND -1 0 0 0 s;COMMAND|COUNT 2 0 0 0 s',
    'COMMAND|DOCS -2 0 0 0 s;COMMAND|GETKEYS -3 0 0 0 s;COMMAND|GETKEYSANDFLAGS -3 0 0 0 s;COMMAND|HELP 2 0 0 0 s',
    'COMMAND|INFO -2 0 0 0 s;COMMAND|LIST -2 0 0 0 s;COMMANDLOG -2 0 0 0 s;COMMANDLOG|GET 4 0 0 0 ads',
    'COMMANDLOG|HELP 2 0 0 0 s;COMMANDLOG|LEN 3 0 0 0 ads;COMMANDLOG|RESET 3 0 0 0 ads;CONFIG -2 0 0 0 s',
    'CONFIG|GET -3 0 0 0 ads;CONFIG|HELP 2 0 0 0 s;CONFIG|RESETSTAT 2 0 0 0 ads;CONFIG|REWRITE 2 0 0 0 ads',
    'CONFIG|SET -4 0 0 0 ads;COPY -3 1 2 1 ws;DBSIZE 1 0 0 0 r;DEBUG -2 0 0 0 ads;DECR 2 1 1 1 w;DECRBY 3 1 1 1 w',
    'DEL -2 1 -1 1 ws;DELEX -2 1 1 1 w;DELIFEQ 3 1 1 1 w;DIGEST 2 1 1 1 r;DISCARD 1 0 0 0 ;DUMP 2 1 1 1 rs',
    'ECHO 2 0 0 0 ;EVAL -3 0 0 0 msx;EVALSHA -3 0 0 0 msx;EVALSHA_RO -3 0 0 0 rmsx;EVAL_RO -3 0 0 0 rmsx',
    'EXEC 1 0 0 0 s;EXISTS -2 1 -1 1 r;EXPIRE -3 1 1 1 w;EXPIREAT -3 1 1 1 w;EXPIRETIME 2 1 1 1 r',
    'FAILOVER -1 0 0 0 ads;FCALL -3 0 0 0 msx;FCALL_RO -3 0 0 0 rmsx;FLUSHALL -1 0 0 0 wds;FLUSHDB -1 0 0 0 wds',
    'FUNCTION -2 0 0 0 s;FUNCTION|DELETE 3 0 0 0 wsx;FUNCTION|DUMP 2 0 0 0 sx;FUNCTION|FLUSH -2 0 0 0 wsx',
    'FUNCTION|HELP 2 0 0 0 sx;FUNCTION|KILL 2 0 0 0 sx;FUNCTION|LIST -2 0 0 0 sx;FUNCTION|LOAD -3 0 0 0 wsx',
    'FUNCTION|RESTORE -3 0 0 0 wsx;FUNCTION|STATS 2 0 0 0 sx;GEOADD -5 1 1 1 ws;GEODIST -4 1 1 1 rs',
    'GEOHASH -2 1 1 1 rs;GEOPOS -2 1 1 1 rs;GEORADIUS -6 1 1 1 wms;GEORADIUSBYMEMBER -5 1 1 1 wms',
    'GEORADIUSBYMEMBER_RO -5 1 1 1 rs;GEORADIUS_RO -6 1 1 1 rs;GEOSEARCH -7 1 1 1 rs;GEOSEARCHSTORE -8 1 2 1 ws',
    'GET 2 1 1 1 r;GETBIT 3 1 1 1 r;GETDEL 2 1 1 1 w;GETEX -2 1 1 1 w;GETRANGE 4 1 1 1 rs;GETSET 3 1 1 1 w',
    'HDEL -3 1 1 1 w;HELLO -1 0 0 0 ;HEXISTS 3 1 1 1 r;HEXPIRE -6 1 1 1 w;HEXPIREAT -6 1 1 1 w',
    'HEXPIRETIME -5 1 1 1 r;HGET 3 1 1 1 r;HGETALL 2 1 1 1 rs;HGETDEL -5 1 1 1 w;HGETEX -5 1 1 1 w',
    'HIMPORT -2 0 0 0 s;HIMPORT|DISCARD 3 0 0 0 s;HIMPORT|DISCARDALL 2 0 0 0 s;HIMPORT|PREPARE -4 0 0 0 s',
    'HIMPORT|SET -5 2 2 1 ws;HINCRBY 4 1 1 1 w;HINCRBYFLOAT 4 1 1 1 w;HKEYS 2 1 1 1 rs;HLEN 2 1 1 1 r',
    'HMGET -3 1 1 1 r;HMSET -4 1 1 1 w;HOTKEYS -2 0 0 0 s;HOTKEYS|GET 2 0 0 0 ads;HOTKEYS|HELP 2 0 0 0 s',
    'HOTKEYS|RESET 2 0 0 0 ads;HOTKEYS|START -2 0 0 0 ads;HOTKEYS|STOP 2 0 0 0 ads;HPERSIST -5 1 1 1 w',
    'HPEXPIRE -6 1 1 1 w;HPEXPIREAT -6 1 1 1 w;HPEXPIRETIME -5 1 1 1 r;HPTTL -5 1 1 1 r;HRANDFIELD -2 1 1 1 rs',
    'HSCAN -3 1 1 1 rs;HSET -4 1 1 1 w;HSETEX -6 1 1 1 w;HSETNX 4 1 1 1 w;HSTRLEN 3 1 1 1 r;HTTL -5 1 1 1 r',
    'HVALS 2 1 1 1 rs;INCR 2 1 1 1 w;INCRBY 3 1 1 1 w;INCRBYFLOAT 3 1 1 1 w;INCREX -2 1 1 1 w;INFO -1 0 0 0 ds',
    'KEYS 2 0 0 0 rds;LASTSAVE 1 0 0 0 d;LATENCY -2 0 0 0 s;LATENCY|DOCTOR 2 0 0 0 ads;LATENCY|GRAPH 3 0 0 0 ads',
    'LATENCY|HELP 2 0 0 0 s;LATENCY|HISTOGRAM -2 0 0 0 ads;LATENCY|HISTORY 3 0 0 0 ads;LATENCY|LATEST 2 0 0 0 ads',
    'LATENCY|RESET -2 0 0 0 ads;LCS -3 1 2 1 rs;LINDEX 3 1 1 1 rs;LINSERT 5 1 1 1 ws;LLEN 2 1 1 1 r',
    'LMOVE 5 1 2 1 ws;LMOVEM -5 1 2 1 ws;LMPOP -4 0 0 0 wms;LOLWUT -1 0 0 0 r;LPOP -2 1 1 1 w;LPOS -3 1 1 1 rs',
    'LPUSH -3 1 1 1 w;LPUSHX -3 1 1 1 w;LRANGE 4 1 1 1 rs;LREM 4 1 1 1 ws;LSET 4 1 1 1 ws;LTRIM 4 1 1 1 ws',
    'MEMORY -2 0 0 0 s;MEMORY|DOCTOR 2 0 0 0 s;MEMORY|HELP 2 0 0 0 s;MEMORY|MALLOC-STATS 2 0 0 0 s',
    'MEMORY|PURGE 2 0 0 0 s;MEMORY|STATS 2 0 0 0 s;MEMORY|USAGE -3 2 2 1 rs;MGET -2 1 -1 1 r',
    'MIGRATE -6 3 3 1 wmds;MODULE -2 0 0 0 s;MODULE|HELP 2 0 0 0 s;MODULE|LIST 2 0 0 0 ads',
    'MODULE|LOAD -3 0 0 0 ads;MODULE|LOADEX -3 0 0 0 ads;MODULE|UNLOAD 3 0 0 0 ads;MONITOR 1 0 0 0 ads',
    'MOVE 3 1 1 1 w;MSET -3 1 -1 2 ws;MSETEX -4 0 0 0 wms;MSETNX -3 1 -1 2 ws;MULTI 1 0 0 0 ;OBJECT -2 0 0 0 s',
    'OBJECT|ENCODING 3 2 2 1 rs;OBJECT|FREQ 3 2 2 1 rs;OBJECT|HELP 2 0 0 0 s;OBJECT|IDLETIME 3 2 2 1 rs',
    'OBJECT|REFCOUNT 3 2 2 1 rs;PERSIST 2 1 1 1 w;PEXPIRE -3 1 1 1 w;PEXPIREAT -3 1 1 1 w;PEXPIRETIME 2 1 1 1 r',
    'PFADD -2 1 1 1 w;PFCOUNT -2 1 -1 1 rs;PFDEBUG 3 2 2 1 wads;PFMERGE -2 1 -1 1 ws;PFSELFTEST 1 0 0 0 ads',
    'PING -1 0 0 0 ;PSETEX 4 1 1 1 ws;PSUBSCRIBE -2 0 0 0 ps;PSYNC -3 0 0 0 ads;PTTL 2 1 1 1 r;PUBLISH 3 0 0 0 p',
    'PUBSUB -2 0 0 0 s;PUBSUB|CHANNELS -2 0 0 0 ps;PUBSUB|HELP 2 0 0 0 s;PUBSUB|NUMPAT 2 0 0 0 ps',
    'PUBSUB|NUMSUB -2 0 0 0 ps;PUBSUB|SHARDCHANNELS -2 0 0 0 ps;PUBSUB|SHARDNUMSUB -2 0 0 0 ps',
    'PUNSUBSCRIBE -1 0 0 0 ps;QUIT -1 0 0 0 ;RANDOMKEY 1 0 0 0 rs;READONLY 1 0 0 0 ;READWRITE 1 0 0 0 ',
    'RENAME 3 1 2 1 ws;RENAMENX 3 1 2 1 w;REPLCONF -1 0 0 0 ads;REPLICAOF 3 0 0 0 ads;RESET 1 0 0 0 ',
    'RESTORE -4 1 1 1 wds;RESTORE-ASKING -4 1 1 1 wds;ROLE 1 0 0 0 d;RPOP -2 1 1 1 w;RPOPLPUSH 3 1 2 1 ws',
    'RPUSH -3 1 1 1 w;RPUSHX -3 1 1 1 w;SADD -3 1 1 1 w;SAVE 1 0 0 0 ads;SCAN -2 0 0 0 rs;SCARD 2 1 1 1 r',
    'SCRIPT -2 0 0 0 s;SCRIPT|DEBUG -3 0 0 0 sx;SCRIPT|EXISTS -3 0 0 0 sx;SCRIPT|FLUSH -2 0 0 0 sx',
    'SCRIPT|HELP 2 0 0 0 sx;SCRIPT|KILL 2 0 0 0 sx;SCRIPT|LOAD 3 0 0 0 sx;SCRIPT|SHOW 3 0 0 0 sx',
    'SDIFF -2 1 -1 1 rs;SDIFFCARD -3 0 0 0 rms;SDIFFSTORE -3 1 -1 1 ws;SELECT 2 0 0 0 ;SET -3 1 1 1 ws',
    'SETBIT 4 1 1 1 ws;SETEX 4 1 1 1 ws;SETNX 3 1 1 1 w;SETRANGE 4 1 1 1 ws;SHUTDOWN -1 0 0 0 ads',
    'SINTER -2 1 -1 1 rs;SINTERCARD -3 0 0 0 rms;SINTERSTORE -3 1 -1 1 ws;SISMEMBER 3 1 1 1 r;SLAVEOF 3 0 0 0 ads',
    'SLOWLOG -2 0 0 0 s;SLOWLOG|GET -2 0 0 0 ads;SLOWLOG|HELP 2 0 0 0 s;SLOWLOG|LEN 2 0 0 0 ads',
    'SLOWLOG|RESET 2 0 0 0 ads;SMEMBERS 2 1 1 1 rs;SMISMEMBER -3 1 1 1 r;SMOVE 4 1 2 1 w;SORT -2 1 1 1 wmds',
    'SORT_RO -2 1 1 1 rmds;SPOP -2 1 1 1 w;SPUBLISH 3 1 1 1 p;SRANDMEMBER -2 1 1 1 rs;SREM -3 1 1 1 w',
    'SSCAN -3 1 1 1 rs;SSUBSCRIBE -2 1 -1 1 ps;STRLEN 2 1 1 1 r;SUBSCRIBE -2 0 0 0 ps;SUBSTR 4 1 1 1 rs',
    'SUNION -2 1 -1 1 rs;SUNIONCARD -3 0 0 0 rms;SUNIONSTORE -3 1 -1 1 ws;SUNSUBSCRIBE -1 1 -1 1 ps',
    'SWAPDB 3 0 0 0 wd;SYNC 1 0 0 0 ads;TIME 1 0 0 0 ;TOUCH -2 1 -1 1 r;TRIMSLOTS -5 0 0 0 wds;TTL 2 1 1 1 r',
    'TYPE 2 1 1 1 r;UNLINK -2 1 -1 1 w;UNSUBSCRIBE -1 0 0 0 ps;UNWATCH 1 0 0 0 ;VADD -5 1 1 1 w;VCARD 2 1 1 1 r',
    'VDIM 2 1 1 1 r;VEMB -3 1 1 1 r;VGETATTR 3 1 1 1 r;VINFO 2 1 1 1 r;VISMEMBER 3 1 1 1 r;VLINKS -3 1 1 1 r',
    'VRANDMEMBER -2 1 1 1 r;VRANGE -4 1 1 1 r;VREM 3 1 1 1 w;VSETATTR 4 1 1 1 w;VSIM -4 1 1 1 r;WAIT 3 0 0 0 bs',
    'WAITAOF 4 0 0 0 bs;WATCH -2 1 -1 1 ;XACK -4 1 1 1 w;XACKDEL -6 1 1 1 w;XADD -5 1 1 1 w;XAUTOCLAIM -6 1 1 1 w',
    'XCFGSET -2 1 1 1 w;XCLAIM -6 1 1 1 w;XDEL -3 1 1 1 w;XDELEX -5 1 1 1 w;XGROUP -2 0 0 0 s',
    'XGROUP|CREATE -5 2 2 1 ws;XGROUP|CREATECONSUMER 5 2 2 1 ws;XGROUP|DELCONSUMER 5 2 2 1 ws',
    'XGROUP|DESTROY 4 2 2 1 ws;XGROUP|HELP 2 0 0 0 s;XGROUP|SETID -5 2 2 1 ws;XIDMPRECORD 5 1 1 1 w',
    'XINFO -2 0 0 0 s;XINFO|CONSUMERS 4 2 2 1 rs;XINFO|GROUPS 3 2 2 1 rs;XINFO|HELP 2 0 0 0 s',
    'XINFO|STREAM -3 2 2 1 rs;XLEN 2 1 1 1 r;XNACK -7 1 1 1 w;XPENDING -3 1 1 1 rs;XRANGE -4 1 1 1 rs',
    'XREAD -4 0 0 0 rmbs;XREADGROUP -7 0 0 0 wmbs;XREVRANGE -4 1 1 1 rs;XSETID -3 1 1 1 w;XTRIM -4 1 1 1 ws',
    'ZADD -4 1 1 1 w;ZCARD 2 1 1 1 r;ZCOUNT 4 1 1 1 r;ZDIFF -3 0 0 0 rms;ZDIFFSTORE -4 1 1 1 wms',
    'ZINCRBY 4 1 1 1 w;ZINTER -3 0 0 0 rms;ZINTERCARD -3 0 0 0 rms;ZINTERSTORE -4 1 1 1 wms;ZLEXCOUNT 4 1 1 1 r',
    'ZMPOP -4 0 0 0 wms;ZMSCORE -3 1 1 1 r;ZPOPMAX -2 1 1 1 w;ZPOPMIN -2 1 1 1 w;ZRANDMEMBER -2 1 1 1 rs',
    'ZRANGE -4 1 1 1 rs;ZRANGEBYLEX -4 1 1 1 rs;ZRANGEBYSCORE -4 1 1 1 rs;ZRANGESTORE -5 1 2 1 ws',
    'ZRANK -3 1 1 1 r;ZREM -3 1 1 1 w;ZREMRANGEBYLEX 4 1 1 1 ws;ZREMRANGEBYRANK 4 1 1 1 ws',
    'ZREMRANGEBYSCORE 4 1 1 1 ws;ZREVRANGE -4 1 1 1 rs;ZREVRANGEBYLEX -4 1 1 1 rs;ZREVRANGEBYSCORE -4 1 1 1 rs',
    'ZREVRANK -3 1 1 1 r;ZSCAN -3 1 1 1 rs;ZSCORE 3 1 1 1 r;ZUNION -3 0 0 0 rms;ZUNIONSTORE -4 1 1 1 wms'
  ].join(";");

  const COMMANDS = new Map();
  for (const part of COMMAND_TABLE.split(';')) {
    const f = part.split(' ');
    COMMANDS.set(f[0], { arity: +f[1], first: +f[2], last: +f[3], step: +f[4], flags: f[5] || '' });
  }
  // Commands with subcommands, such as CLIENT and CONFIG.
  const CONTAINERS = new Set();
  for (const name of COMMANDS.keys()) if (name.includes('|')) CONTAINERS.add(name.split('|')[0]);

  // Inside, arguments are byte strings: one character per byte, codes 0 to
  // 255. MONITOR writes plain ASCII, so most arguments are just a slice of
  // the line, and keys work as Map keys without copying. The functions meant
  // for outside callers also take Uint8Arrays.
  const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
  const fromLatin1 = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
  const bstr = (x) => (typeof x === 'string' ? x : latin1(x));
  const WIDE = /[^\x00-\x7f]/;
  // Text from bytes: the string itself when it's ASCII, UTF-8 otherwise.
  const textOf = (s) => (WIDE.test(s) ? decoder.decode(fromLatin1(s)) : s);
  const upper = (s) => textOf(s).toUpperCase();
  // A copy of a string that doesn't keep the text it was cut from in memory.
  // Engines like V8 share the parent string with every slice, so a stored
  // key would otherwise hold on to the whole piece of file it came from.
  const copy = (s) => (s.length < 13 ? s : JSON.parse(JSON.stringify(s)));

  // The table entry for a command, using the subcommand when it has one:
  // { name, base, arity, first, last, step, flags }, plus unknown: true for
  // commands not in the table. The same object comes back every time.
  const INFOS = new Map();
  function info(id, name, base, c) {
    let x = INFOS.get(id);
    if (!x) {
      name = copy(name); base = copy(base);
      x = c ? Object.assign({ name: name, base: base }, c) : { name: name, base: base, arity: 0, first: 0, last: 0, step: 0, flags: '', unknown: true };
      INFOS.set(copy(id), x);
    }
    return x;
  }
  function infoOf(args) {
    if (!args.length) return null;
    const name = upper(args[0]);
    if (args.length > 1 && CONTAINERS.has(name)) {
      const sub = upper(args[1]);
      const c = COMMANDS.get(name + '|' + sub);
      if (c) return info(name + '|' + sub, name + ' ' + sub, name, c);
    }
    return info(name, name, name, COMMANDS.get(name));
  }
  function commandInfo(args) { return infoOf(args.slice(0, 2).map(bstr)); }

  // Positions of the keys in a command. Most commands describe them with a
  // first, last and step; the rest need their own rules.
  function range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; }
  function numkeysAt(args, pos, extra) {
    const n = parseInt(args[pos] || '', 10);
    if (!(n >= 0) || pos + 1 + n > args.length) return extra || [];
    return (extra || []).concat(range(pos + 1, pos + 1 + n));
  }
  const MOVABLE = {
    EVAL: (a) => numkeysAt(a, 2), EVALSHA: (a) => numkeysAt(a, 2), EVAL_RO: (a) => numkeysAt(a, 2), EVALSHA_RO: (a) => numkeysAt(a, 2),
    FCALL: (a) => numkeysAt(a, 2), FCALL_RO: (a) => numkeysAt(a, 2),
    ZUNION: (a) => numkeysAt(a, 1), ZINTER: (a) => numkeysAt(a, 1), ZDIFF: (a) => numkeysAt(a, 1), ZINTERCARD: (a) => numkeysAt(a, 1),
    SINTERCARD: (a) => numkeysAt(a, 1), SUNIONCARD: (a) => numkeysAt(a, 1), SDIFFCARD: (a) => numkeysAt(a, 1),
    LMPOP: (a) => numkeysAt(a, 1), ZMPOP: (a) => numkeysAt(a, 1), BLMPOP: (a) => numkeysAt(a, 2), BZMPOP: (a) => numkeysAt(a, 2),
    ZUNIONSTORE: (a) => numkeysAt(a, 2, [1]), ZINTERSTORE: (a) => numkeysAt(a, 2, [1]), ZDIFFSTORE: (a) => numkeysAt(a, 2, [1]),
    XREAD: streams, XREADGROUP: streams,
    SORT: sortKeys, SORT_RO: (a) => (a.length > 1 ? [1] : []),
    GEORADIUS: georadius, GEORADIUSBYMEMBER: georadius,
    // MIGRATE host port key|"" db timeout [COPY] [REPLACE] [AUTH ...] [KEYS key ...]
    MIGRATE: (a) => {
      for (let i = 6; i < a.length; i++) {
        const t = upper(a[i]);
        if (t === 'KEYS') return a[3].length ? [] : range(i + 1, a.length);
        if (t === 'AUTH') i += 1;
        else if (t === 'AUTH2') i += 2;
      }
      return a.length > 3 && a[3].length ? [3] : [];
    },
    // Valkey's CLUSTERSCAN takes a cursor where the table says a key would be.
    CLUSTERSCAN: () => [],
    // MSETEX numkeys key value [key value ...] [options]
    MSETEX: (a) => {
      const n = parseInt(a[1] || '', 10);
      if (!(n >= 1) || 1 + n * 2 > a.length - 1) return [];
      return range(0, n).map((i) => 2 + i * 2);
    }
  };
  // XREAD and XREADGROUP: the options before STREAMS are skipped the way
  // the servers do it, since a group or consumer can be named STREAMS too.
  function streams(a) {
    for (let i = 1; i < a.length; i++) {
      const t = upper(a[i]);
      if (t === 'BLOCK' || t === 'COUNT' || t === 'MAXCOUNT' || t === 'MAXSIZE' || t === 'CLAIM') i++;
      else if (t === 'GROUP') i += 2;
      else if (t === 'NOACK') continue;
      else if (t === 'STREAMS') { const rest = a.length - i - 1; return rest && rest % 2 === 0 ? range(i + 1, i + 1 + rest / 2) : []; }
      else return [];
    }
    return [];
  }
  // SORT key [BY pattern] [LIMIT offset count] [GET pattern ...] [ASC|DESC] [ALPHA] [STORE destination]
  function sortKeys(a) {
    if (a.length < 2) return [];
    let store = 0;
    for (let i = 2; i < a.length; i++) {
      const t = upper(a[i]);
      if (t === 'LIMIT') i += 2;
      else if (t === 'STORE' && i + 1 < a.length) { store = i + 1; i += 1; }
      else if (t === 'GET' || t === 'BY') i += 1;
    }
    return store ? [1, store] : [1];
  }
  // GEORADIUS key longitude latitude radius unit [... STORE key | STOREDIST key]
  function georadius(a) {
    if (a.length < 2) return [];
    let store = 0;
    for (let i = 5; i < a.length; i++) { const t = upper(a[i]); if ((t === 'STORE' || t === 'STOREDIST') && i + 1 < a.length) { store = i + 1; i += 1; } }
    return store ? [1, store] : [1];
  }
  function positions(args, inf) {
    if (!inf) return [];
    if (MOVABLE[inf.base]) return MOVABLE[inf.base](args);
    // Shard channels hash to slots like keys, but they aren't keys.
    if (!inf.first || inf.flags.includes('p')) return [];
    const last = inf.last < 0 ? args.length + inf.last : inf.last;
    const out = [];
    for (let i = inf.first; i <= last && i < args.length; i += inf.step || 1) out.push(i);
    return out;
  }
  function keyPositions(args, inf) {
    const a = args.map(bstr);
    return positions(a, inf || infoOf(a));
  }

  // ---- Reading MONITOR lines ----

  // Seconds and microseconds, printed as %ld.%06ld: ten digits from 2001 to
  // 2286. A line cut short at the front, as split -b or tail -c leave it,
  // doesn't match.
  const HEAD = /^(\d{10})\.(\d{6}) \[(\d+) /;
  const ESC = { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\x08', '"': '"', '\\': '\\' };
  const HEX = (c) => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1);
  // Characters beyond ASCII, as in a capture some other tool saved as UTF-8,
  // become their UTF-8 bytes.
  const utf8 = (s) => (WIDE.test(s) ? latin1(encoder.encode(s)) : s);

  // One line, such as
  //   1791218550.753456 [0 127.0.0.1:54650] "SET" "k" "v"
  // as { sec, usec, db, client, args } with byte strings, or null.
  function scan(line) {
    let end = line.length;
    if (end && line.charCodeAt(end - 1) === 13) end--;
    let i = line.charCodeAt(0) === 43 ? 1 : 0; // a leading + when read straight off the socket
    const m = HEAD.exec(i ? line.slice(1, 40) : line.slice(0, 40));
    if (!m) return null;
    i += m[0].length;
    const close = line.indexOf('] "', i);
    if (close < 0 || close >= end) return null;
    const client = line.slice(i, close);
    i = close + 2;
    const wide = WIDE.test(line);
    const args = [];
    while (i < end) {
      const c = line.charCodeAt(i);
      if (c === 32) { i++; continue; }
      if (c !== 34) return null;
      let start = ++i, parts = null, pieces = null, done = false;
      while (i < end) {
        const ch = line.charCodeAt(i);
        if (ch === 34) { done = true; break; }
        if (ch === 92 && i + 1 < end) {
          const e = line[i + 1];
          let rep = null, skip = 2;
          if (e === 'x' && i + 3 < end) {
            const h = HEX(line.charCodeAt(i + 2)), l = HEX(line.charCodeAt(i + 3));
            if (h >= 0 && l >= 0) { rep = String.fromCharCode(h * 16 + l); skip = 4; }
          }
          if (rep === null && ESC[e] !== undefined) rep = ESC[e];
          if (rep !== null) {
            const lit = line.slice(start, i);
            (parts || (parts = [])).push(wide ? utf8(lit) : lit, rep);
            if (parts.length >= 8192) { (pieces || (pieces = [])).push(parts.join('')); parts = []; }
            i += skip; start = i;
            continue;
          }
        }
        i++;
      }
      if (!done) return null;
      const lit = line.slice(start, i);
      if (parts) { parts.push(wide ? utf8(lit) : lit); if (pieces) { pieces.push(parts.join('')); args.push(pieces.join('')); } else args.push(parts.join('')); }
      else args.push(wide ? utf8(lit) : lit);
      i++;
    }
    if (!args.length) return null;
    return { sec: +m[1], usec: +m[2], db: +m[3], client: client, args: args };
  }
  // The same, with each argument as a Uint8Array.
  function parseLine(line) {
    const c = scan(line);
    if (c) c.args = c.args.map(fromLatin1);
    return c;
  }

  // ---- Small helpers ----

  // Cluster slot of a key: CRC16 (XMODEM) of the key, or of its hash tag.
  const CRC = new Uint16Array(256);
  for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1; CRC[i] = c & 0xffff; }
  function slotOf(s) {
    let a = 0, e = s.length;
    const open = s.indexOf('{');
    if (open >= 0) { const close = s.indexOf('}', open + 1); if (close > open + 1) { a = open + 1; e = close; } }
    let crc = 0;
    for (let i = a; i < e; i++) crc = ((crc << 8) ^ CRC[((crc >> 8) ^ s.charCodeAt(i)) & 0xff]) & 0xffff;
    return crc & 16383;
  }
  const keySlot = (b) => slotOf(bstr(b));
  // The slot ranges --cluster create gives n primaries. It does the sums in
  // 32-bit floats, so this does too.
  function evenSplit(n) {
    n = Math.max(1, Math.min(16384, Math.floor(n) || 1));
    const f = Math.fround, per = f(16384 / n), out = [];
    let first = 0, cursor = f(0);
    for (let i = 0; i < n; i++) {
      let last = Math.round(f(f(cursor + per) - 1));
      if (last > 16384 || i === n - 1) last = 16383;
      if (last < first) last = first;
      out.push([first, last]);
      first = last + 1;
      cursor = f(cursor + per);
    }
    return out;
  }

  // A key as text when it's printable UTF-8, in quotes when it has spaces or
  // quotes, and as bytes with \xHH escapes when it isn't text at all.
  function showKey(b) {
    const s = bstr(b);
    let t = null;
    if (!WIDE.test(s)) t = s;
    else { try { t = strictDecoder.decode(fromLatin1(s)); } catch (e) { /* not UTF-8 */ } }
    if (t !== null && !/[\x00-\x1f\x7f-\x9f]/.test(t)) {
      if (t.length && !/[ "\\]/.test(t)) return t;
      return '"' + t.replace(/["\\]/g, '\\$&') + '"';
    }
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x5c) out += '\\\\'; else if (c === 0x22) out += '\\"'; else if (c === 10) out += '\\n'; else if (c === 13) out += '\\r';
      else if (c === 9) out += '\\t'; else if (c >= 0x20 && c < 0x7f) out += s[i]; else out += '\\x' + c.toString(16).padStart(2, '0');
    }
    return out + '"';
  }

  // Key patterns, with the same separators and placeholders as the Keyspace
  // Map: the separator most keys use, and segments such as numbers, UUIDs and
  // dates folded into <id>, <uuid>, <date> and so on. Placeholders use angle
  // brackets, since braces mean hash tags in keys.
  const SEPARATORS = [':', '/', '|', '#', '.', '_', '-'];
  function guessSeparator(texts) {
    const sample = texts.length > 20000 ? texts.filter((_, i) => i % Math.ceil(texts.length / 20000) === 0) : texts;
    let best = '', bestShare = 0;
    for (const sep of SEPARATORS) {
      let n = 0;
      for (const t of sample) if (t.includes(sep)) n++;
      const share = n / (sample.length || 1);
      const weak = sep === '.' || sep === '_' || sep === '-';
      if (share >= (weak ? 0.6 : 0.3) && share > bestShare + (weak ? 0.15 : 0)) { best = sep; bestShare = share; }
    }
    return best;
  }
  const CLASSES = [
    ['<uuid>', /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/],
    ['<id>', /^\d+$/],
    ['<date>', /^\d{4}-\d{2}(-\d{2}([T ]\d{2}(:\d{2}(:\d{2}(\.\d+)?)?)?Z?)?)?$/],
    ['<email>', /^[^@\s]+@[^@\s]+\.[^@\s]+$/],
    ['<ip>', /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/],
    ['<hex>', /^(?=.*\d)(?=.*[a-fA-F])[0-9a-fA-F]{12,}$/],
    ['<token>', /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_+=\/-]{20,}$/]
  ];
  function classify(seg) {
    // Every class but <email> needs a digit; plain words go through fast.
    if (!/[\d@]/.test(seg)) return seg;
    const tag = /^\{(.+)\}$/.exec(seg);
    const inner = tag ? tag[1] : seg;
    for (const [name, re] of CLASSES) if (re.test(inner)) return tag ? '{' + name + '}' : name;
    return seg;
  }
  // The key as text, or null when it isn't UTF-8.
  function keyText(s) {
    if (!WIDE.test(s)) return s;
    try { return strictDecoder.decode(fromLatin1(s)); } catch (e) { return null; }
  }
  function keyPattern(b, sep) {
    const t = keyText(bstr(b));
    if (t === null) return '(binary keys)';
    if (sep === undefined) sep = guessSeparator([t]);
    const p = (sep ? t.split(sep) : [t]).map(classify).join(sep || '');
    return p.replace(/[\x00-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  }

  // A growing typed array.
  function growable(Type) {
    let a = new Type(4096), n = 0;
    return {
      push(v) { if (n === a.length) { const b = new Type(a.length * 2); b.set(a); a = b; } a[n++] = v; },
      inc(i) { a[i]++; },
      at(i) { return a[i]; },
      get length() { return n; },
      view() { return a.subarray(0, n); }
    };
  }

  // ---- The analysis ----

  const READ = 0, WRITE = 1, DELETE = 2, FLUSH = 3;
  const DELETES = new Set(['DEL', 'UNLINK', 'GETDEL']);
  const WHOLE = new Set(['SMEMBERS', 'HGETALL', 'HKEYS', 'HVALS', 'SUNION', 'SINTER', 'SDIFF']);
  const SETUP = new Set(['AUTH', 'HELLO', 'SELECT', 'CLIENT SETNAME', 'CLIENT SETINFO']);
  const EXPIRES = new Set(['EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT']);
  const TTL_OPTION = /^(EX|PX|EXAT|PXAT|KEEPTTL)$/i;
  const BIG = 100 * 1024;
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400];

  // Reads MONITOR lines one at a time, or a file in pieces, and keeps counts.
  // opts.curve: false skips the record the hit-rate curve needs.
  // opts.maxAccesses: the most key accesses kept for the curve (30 million).
  function analyzer(opts) {
    opts = opts || {};
    const keepAccesses = opts.curve !== false;
    const maxAccesses = opts.maxAccesses || 30000000;
    const st = {
      lines: 0, commands: 0, unparsed: 0, unparsedExamples: [], first: null, last: null,
      perSecond: new Map(), byCommand: new Map(), byDb: new Map(), hosts: new Map(), conns: new Map(),
      // Keys: a number per key in each database, and per number its name,
      // database and counts.
      keyIds: new Map(), names: [], dbs: growable(Int32Array), reads: growable(Uint32Array), writes: growable(Uint32Array), deletes: growable(Uint32Array),
      slots: new Float64Array(16384), slotKeys: 0, bytes: 0,
      crossSlot: 0, crossSlotExamples: [], kinds: { read: 0, write: 0, script: 0, pubsub: 0, other: 0 },
      risky: new Map(), multi: 0, luaLines: 0, scripts: 0, evalCalls: 0, setup: 0, crossScript: false,
      accKeys: growable(Int32Array), accOps: growable(Uint8Array), partial: false, unknown: new Map()
    };
    let pending = []; // the start of a line that hasn't ended yet, in pieces
    const note = (id, example) => {
      const r = st.risky.get(id) || { count: 0, examples: [] };
      r.count++;
      if (example !== undefined && r.examples.length < 3 && !r.examples.includes(example)) r.examples.push(copy(example));
      st.risky.set(id, r);
    };
    const short = (args) => args.slice(0, 6).map((a) => showKey(a.length > 60 ? a.slice(0, 60) : a) + (a.length > 60 ? '...' : '')).join(' ') + (args.length > 6 ? ' ...' : '');
    const record = (k, op) => {
      if (!keepAccesses) return;
      if (st.accKeys.length >= maxAccesses) { st.partial = true; return; }
      st.accKeys.push(k); st.accOps.push(op);
    };

    // One command, from scan(): arguments as byte strings.
    function add(cmd) {
      st.commands++;
      const t = cmd.sec * 1e6 + cmd.usec;
      if (st.first === null || t < st.first) st.first = t;
      if (st.last === null || t > st.last) st.last = t;
      st.perSecond.set(cmd.sec, (st.perSecond.get(cmd.sec) || 0) + 1);
      const args = cmd.args;
      const inf = infoOf(args);
      const name = inf.name, base = inf.base, flags = inf.flags;
      if (inf.unknown) st.unknown.set(name, (st.unknown.get(name) || 0) + 1);
      const kind = flags.includes('x') ? 'script' : flags.includes('p') ? 'pubsub' : flags.includes('w') ? 'write' : flags.includes('r') ? 'read' : 'other';
      st.kinds[kind]++;
      let size = 0, big = 0;
      for (const a of args) { size += a.length; if (a.length > big) big = a.length; }
      st.bytes += size;
      let c = st.byCommand.get(name);
      if (!c) { c = { count: 0, kind: kind, bytes: 0 }; st.byCommand.set(name, c); }
      c.count++; c.bytes += size;
      st.byDb.set(cmd.db, (st.byDb.get(cmd.db) || 0) + 1);

      // Who sent it: the connection, and its address without the port.
      if (cmd.client === 'lua') st.luaLines++;
      else st.crossScript = false;
      let conn = st.conns.get(cmd.client);
      if (!conn) {
        const host = cmd.client === 'lua' ? 'lua' : cmd.client.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
        let h = st.hosts.get(host);
        if (!h) { h = { count: 0, conns: 0, commands: new Map() }; st.hosts.set(copy(host), h); }
        h.conns++;
        conn = { count: 0, multi: false, lastSet: -1, host: h };
        st.conns.set(copy(cmd.client), conn);
      }
      conn.count++;
      const h = conn.host;
      h.count++;
      h.commands.set(name, (h.commands.get(name) || 0) + 1);

      if (base === 'MULTI') { st.multi++; conn.multi = true; }
      else if (base === 'EXEC' || base === 'DISCARD') conn.multi = false;
      if (flags.includes('x') && (base.startsWith('EVAL') || base.startsWith('FCALL'))) { st.scripts++; if (base === 'EVAL' || base === 'EVAL_RO') st.evalCalls++; }
      if (SETUP.has(name)) st.setup++;

      // Commands worth a second look.
      if (base === 'KEYS') note('keys', short(args));
      else if (base === 'FLUSHALL' || base === 'FLUSHDB') note('flush', short(args));
      if (WHOLE.has(base)) note('whole', short(args));
      else if ((base === 'LRANGE' || base === 'ZRANGE' || base === 'ZREVRANGE') && args.length >= 4 && args[2] === '0' && args[3] === '-1') note('whole', short(args));
      if (big >= BIG) note('large', name + ' ' + showKey((args[1] || '').slice(0, 60)) + ' (' + Math.round(big / 1024) + ' KB)');
      if (cmd.db !== 0 && base !== 'SELECT') note('databases', 'database ' + cmd.db);
      const lastSet = conn.lastSet;
      conn.lastSet = -1;
      // A script runs as one step, and every client on the Unix socket shows
      // the same address, so neither can leave a key between SET and EXPIRE.
      const ownConnection = cmd.client !== 'lua' && !cmd.client.startsWith('unix:');

      // Keys. Scripts name their keys, but the commands they run show up as
      // their own lines from "lua", so only those count. Pub/sub channels
      // aren't keys, and WATCH doesn't touch the value.
      if (flags.includes('x')) {
        // A cluster refuses a script or function whose declared keys are in
        // different slots. The commands it ran then aren't counted again.
        let firstSlot = -1, cross = false;
        for (const p of positions(args, inf)) { const slot = slotOf(args[p]); if (firstSlot < 0) firstSlot = slot; else if (slot !== firstSlot) cross = true; }
        if (cross) { st.crossSlot++; if (st.crossSlotExamples.length < 3) st.crossSlotExamples.push(copy(short(args))); }
        st.crossScript = cross;
        return;
      }
      if (flags.includes('p')) return;
      if (base === 'FLUSHALL' || base === 'FLUSHDB') { record(base === 'FLUSHALL' ? -1 : -2 - cmd.db, FLUSH); return; }
      if (!flags.includes('r') && !flags.includes('w')) return;
      const pos = positions(args, inf);
      if (!pos.length) return;
      const op = DELETES.has(base) ? DELETE : flags.includes('w') ? WRITE : READ;
      const counts = op === READ ? st.reads : op === WRITE ? st.writes : st.deletes;
      let ids = st.keyIds.get(cmd.db);
      if (!ids) st.keyIds.set(cmd.db, ids = new Map());
      let firstSlot = -1, cross = false, firstKey = -1;
      for (const p of pos) {
        const key = args[p];
        let k = ids.get(key);
        if (k === undefined) {
          k = st.names.length;
          const name = copy(key);
          ids.set(name, k);
          st.names.push(name);
          st.dbs.push(cmd.db); st.reads.push(0); st.writes.push(0); st.deletes.push(0);
        }
        if (firstKey < 0) firstKey = k;
        counts.inc(k);
        const slot = slotOf(key);
        st.slots[slot]++;
        st.slotKeys++;
        if (firstSlot < 0) firstSlot = slot; else if (slot !== firstSlot) cross = true;
        record(k, op);
      }
      if (cross && !(cmd.client === 'lua' && st.crossScript)) { st.crossSlot++; if (st.crossSlotExamples.length < 3) st.crossSlotExamples.push(copy(short(args))); }
      // SET and then EXPIRE on the same key, outside a transaction.
      if (lastSet >= 0 && firstKey === lastSet && EXPIRES.has(base)) note('set-expire', showKey(args[1]));
      if ((base === 'SET' || base === 'SETNX') && !conn.multi && ownConnection) {
        let ttl = false;
        if (base === 'SET') for (let i = 3; i < args.length; i++) if (TTL_OPTION.test(args[i])) ttl = true;
        if (!ttl) conn.lastSet = firstKey;
      }
    }
    // The same for a command with Uint8Array arguments, as parseLine gives.
    function addCommand(cmd) { add(Object.assign({}, cmd, { args: cmd.args.map(bstr) })); }

    function addLine(line) {
      if (!line || !line.trim()) return;
      const cmd = scan(line);
      if (!cmd) {
        if (/^\+?OK\s*$/.test(line)) return;
        st.lines++;
        st.unparsed++;
        if (st.unparsedExamples.length < 3) st.unparsedExamples.push(copy(line.slice(0, 120)));
        return;
      }
      st.lines++;
      add(cmd);
    }
    function addText(text) { addChunk(text, true); }
    // Pieces of a file in order; final is true for the last one.
    function addChunk(text, final) {
      let start = 0, nl = text.indexOf('\n');
      if (nl >= 0 && pending.length) {
        pending.push(text.slice(0, nl));
        addLine(pending.join(''));
        pending = [];
        start = nl + 1;
      }
      while ((nl = text.indexOf('\n', start)) >= 0) { addLine(text.slice(start, nl)); start = nl + 1; }
      if (start < text.length) pending.push(text.slice(start));
      if (final) { if (pending.length) addLine(pending.join('')); pending = []; }
    }

    // Key accesses per primary of a new cluster with n primaries.
    function spread(n) {
      const ranges = evenSplit(n);
      const perPrimary = ranges.map(([a, b]) => { let c = 0; for (let s = a; s <= b; s++) c += st.slots[s]; return c; });
      return { ranges: ranges, perPrimary: perPrimary };
    }

    // One key's record, with its name as bytes.
    const keyRecord = (i) => {
      const r = st.reads.at(i), w = st.writes.at(i), d = st.deletes.at(i);
      return { id: i, db: st.dbs.at(i), key: fromLatin1(st.names[i]), reads: r, writes: w, deletes: d, total: r + w + d };
    };

    function result(ropts) {
      ropts = ropts || {};
      const top = ropts.top || 20;
      const primaries = ropts.primaries || 3;
      const startSec = st.first === null ? null : Math.floor(st.first / 1e6);
      const endSec = st.last === null ? null : Math.floor(st.last / 1e6);
      const duration = st.first === null ? 0 : (st.last - st.first) / 1e6;
      // Commands per second, or per longer step for long captures.
      let step = 1;
      const counts = [];
      if (startSec !== null) {
        for (const s of STEPS) { step = s; if ((endSec - startSec) / s < 1500) break; }
        const nb = Math.floor((endSec - startSec) / step) + 1;
        for (let i = 0; i < nb; i++) counts.push(0);
        for (const [t, n] of st.perSecond) counts[Math.floor((t - startSec) / step)] += n;
      }
      // The busiest second that the capture covers from start to end. The
      // first and last seconds are usually covered only in part.
      let peak = null;
      for (const [t, n] of st.perSecond) if (t > startSec && t < endSec && (!peak || n > peak.count || (n === peak.count && t < peak.time))) peak = { time: t, count: n };
      const byCommand = Array.from(st.byCommand.entries()).map(([name, v]) => ({ name: name, count: v.count, kind: v.kind, bytes: v.bytes }))
        .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
      const hosts = Array.from(st.hosts.entries()).map(([host, v]) => ({
        host: host, count: v.count, connections: host === 'lua' ? 0 : v.conns,
        top: Array.from(v.commands.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3)
      })).sort((a, b) => b.count - a.count);
      // Keys: totals, the busiest ones, and patterns.
      const nKeys = st.names.length;
      let reads = 0, writes = 0, deletes = 0, readOnce = 0;
      const best = []; // [total, id], busiest first
      for (let i = 0; i < nKeys; i++) {
        const r = st.reads.at(i), w = st.writes.at(i), d = st.deletes.at(i), t = r + w + d;
        reads += r; writes += w; deletes += d;
        if (r === 1 && w === 0 && d === 0) readOnce++;
        if (best.length < top || t > best[best.length - 1][0]) {
          let j = best.length;
          while (j > 0 && best[j - 1][0] < t) j--;
          best.splice(j, 0, [t, i]);
          if (best.length > top) best.pop();
        }
      }
      const accesses = reads + writes + deletes;
      const busiest = best.map((b) => keyRecord(b[1]));
      const sample = [];
      const every = Math.max(1, Math.floor(nKeys / 20000));
      for (let i = 0; i < nKeys; i += every) { const t = keyText(st.names[i]); if (t !== null) sample.push(t); }
      const sep = guessSeparator(sample);
      const pat = new Map();
      for (let i = 0; i < nKeys; i++) {
        const p = keyPattern(st.names[i], sep);
        let v = pat.get(p);
        if (!v) { v = { pattern: p, keys: 0, accesses: 0, reads: 0, writes: 0, deletes: 0 }; pat.set(p, v); }
        const r = st.reads.at(i), w = st.writes.at(i), d = st.deletes.at(i);
        v.keys++; v.accesses += r + w + d; v.reads += r; v.writes += w; v.deletes += d;
      }
      const patterns = Array.from(pat.values()).sort((a, b) => b.accesses - a.accesses || (a.pattern < b.pattern ? -1 : 1));
      // Cluster spread.
      const { ranges, perPrimary } = spread(primaries);
      const hotSlots = [];
      for (let s = 0; s < 16384; s++) if (st.slots[s]) hotSlots.push({ slot: s, accesses: st.slots[s] });
      hotSlots.sort((a, b) => b.accesses - a.accesses || a.slot - b.slot);
      // Findings, most frequent first.
      const findings = [];
      const found = (id, level, title, count, examples, text) => findings.push({ id: id, level: level, title: title, count: count, examples: examples || [], text: text });
      const r = (id) => st.risky.get(id);
      if (r('keys')) found('keys', 'warn', 'KEYS', r('keys').count, r('keys').examples, 'KEYS walks the whole keyspace in one go, and every other client waits until it\'s done. SCAN does the same job a slice at a time.');
      if (r('flush')) found('flush', 'warn', 'FLUSHALL and FLUSHDB', r('flush').count, r('flush').examples, 'These delete every key in the server or in one database.');
      if (r('whole')) found('whole', 'info', 'Whole-collection reads', r('whole').count, r('whole').examples, 'These return a whole hash, set, list or sorted set at once: quick for small ones, slow for big ones. HSCAN, SSCAN, ZSCAN and ranges read big ones a page at a time.');
      if (r('large')) found('large', 'warn', 'Large values', r('large').count, r('large').examples, 'Arguments of 100 KB or more. Every read and write of a big value takes longer, holds up the clients behind it, and slows down replication.');
      if (st.crossSlot) found('cross-slot', 'warn', 'Commands across cluster slots', st.crossSlot, st.crossSlotExamples, 'These use keys in different hash slots. A cluster refuses them with CROSSSLOT unless the keys share a hash tag, like {user:42}:cart and {user:42}:profile.');
      if (busiest.length && accesses >= 100 && busiest[0].total / accesses >= 0.1) found('hot-key', 'warn', 'A hot key', busiest[0].total, [showKey(busiest[0].key) + ', ' + (100 * busiest[0].total / accesses).toFixed(1) + '% of key accesses'], 'One key takes a large share of the traffic. In a cluster all of it lands on one primary. A local cache in the application, or copies of the key under several names, spread the load.');
      if (r('set-expire')) found('set-expire', 'info', 'SET, then EXPIRE', r('set-expire').count, r('set-expire').examples, 'A key set and then given an expiry in a second command. SET key value EX seconds does both at once, so the key can\'t be left without an expiry if the client stops in between.');
      if (st.evalCalls >= 10 && st.evalCalls / Math.max(1, st.scripts) > 0.5) found('eval', 'info', 'Scripts sent with EVAL', st.evalCalls, [], 'EVAL sends the whole script every time. Load it once and call it with EVALSHA, or make it a function with FUNCTION LOAD and FCALL.');
      if (st.setup >= 20 && st.setup / st.commands >= 0.1) found('setup', 'info', 'Connection setup', st.setup, [], (100 * st.setup / st.commands).toFixed(1) + '% of the commands are AUTH, HELLO, SELECT or CLIENT SETNAME and SETINFO, which clients send when they open a connection. That usually means connections are opened again and again. A connection pool keeps them open.');
      if (r('databases')) found('databases', 'info', 'Databases other than 0', r('databases').count, r('databases').examples, 'Redis Cluster has only database 0, so these would need changing to move to a Redis cluster. Valkey 9 clusters can have more.');
      if (st.unknown.size) found('unknown', 'info', 'Commands not in the table', Array.from(st.unknown.values()).reduce((a, b) => a + b, 0), Array.from(st.unknown.keys()).slice(0, 3), 'These aren\'t commands of Valkey 9.1 or Redis 8.10, perhaps from a module. They are counted, but their keys aren\'t.');
      findings.sort((a, b) => b.count - a.count);
      return {
        lines: st.lines, commands: st.commands, unparsed: st.unparsed, unparsedExamples: st.unparsedExamples,
        start: st.first === null ? null : st.first / 1000, end: st.last === null ? null : st.last / 1000, duration: duration,
        series: { start: startSec, step: step, counts: counts }, peak: peak,
        average: duration > 0 ? st.commands / duration : st.commands,
        bytes: st.bytes, kinds: st.kinds, byCommand: byCommand,
        byDb: Array.from(st.byDb.entries()).map(([db, count]) => ({ db: db, count: count })).sort((a, b) => a.db - b.db),
        hosts: hosts.slice(0, top), hostCount: hosts.filter((x) => x.host !== 'lua').length,
        connections: Array.from(st.conns.keys()).filter((c) => c !== 'lua').length,
        keys: { distinct: nKeys, accesses: accesses, reads: reads, writes: writes, deletes: deletes, readOnce: readOnce, top: busiest },
        separator: sep, patterns: patterns.slice(0, top), patternCount: patterns.length,
        cluster: { primaries: ranges.length, ranges: ranges, perPrimary: perPrimary, keyAccesses: st.slotKeys, slotsUsed: hotSlots.length, hotSlots: hotSlots.slice(0, 10) },
        multi: st.multi, scripts: st.scripts, luaLines: st.luaLines, setup: st.setup,
        findings: findings
      };
    }

    // Reads an LRU cache of each size would serve.
    function curve() {
      const c = lruCurve(st.accKeys.view(), st.accOps.view(), st.names.length, st.dbs.view());
      c.partial = st.partial;
      return c;
    }

    return {
      addLine: addLine, addText: addText, addChunk: addChunk, addCommand: addCommand,
      result: result, curve: curve, spread: spread,
      // Every key: fn(db, key as a byte string, reads, writes, deletes).
      eachKey: (fn) => { for (let i = 0; i < st.names.length; i++) fn(st.dbs.at(i), st.names[i], st.reads.at(i), st.writes.at(i), st.deletes.at(i)); },
      // The same one key at a time: keyCount(), then keyAt(i) as [db, key, reads, writes, deletes].
      keyCount: () => st.names.length,
      keyAt: (i) => [st.dbs.at(i), st.names[i], st.reads.at(i), st.writes.at(i), st.deletes.at(i)],
      keyStats: () => st.names.map((_, i) => keyRecord(i))
    };
  }

  // ---- LRU hit-rate curve ----

  // A least-recently-used cache of every size at once, as a stack: the
  // first c entries are what a cache of c keys holds. Using a key moves it
  // to the top. Deleting a key leaves a hole where it was, a free slot in the
  // caches big enough to hold it, and the next key to come in fills the
  // highest hole instead of pushing everything below it down. A read is
  // served by a cache of c keys when fewer than c entries, holes included,
  // sit above its key. The stack is kept by the time each entry was last
  // used, with a Fenwick tree to count the entries above a time and a heap
  // to find the newest hole.
  // A read of a key that isn't there is assumed to load it, as an
  // application with a cache in front would.
  // keys[i], ops[i]: key number and operation, 0 read, 1 write, 2 delete,
  // 3 flush (key -1 for all databases, -2 - db for one).
  function lruCurve(keys, ops, nKeys, keyDb) {
    const n = keys.length;
    const tree = new Int32Array(n + 1);
    const add = (i, v) => { for (i++; i <= n; i += i & -i) tree[i] += v; };
    const sum = (i) => { let s = 0; for (i++; i > 0; i -= i & -i) s += tree[i]; return s; };
    const last = new Int32Array(nKeys).fill(-1);
    const hist = new Float64Array(nKeys + 1);
    // Max-heap of the times of holes.
    let heap = new Int32Array(64), size = 0;
    const push = (v) => {
      if (size === heap.length) { const b = new Int32Array(size * 2); b.set(heap); heap = b; }
      let i = size++;
      while (i > 0) { const up = (i - 1) >> 1; if (heap[up] >= v) break; heap[i] = heap[up]; i = up; }
      heap[i] = v;
    };
    const pop = () => {
      const top = heap[0], v = heap[--size];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= size) break;
        if (c + 1 < size && heap[c + 1] > heap[c]) c++;
        if (heap[c] <= v) break;
        heap[i] = heap[c]; i = c;
      }
      heap[i] = v;
      return top;
    };
    // For flushes: the keys that came in since the last flush, per database.
    let flushes = false;
    for (let t = 0; t < n; t++) if (ops[t] === FLUSH) { flushes = true; break; }
    const arrivals = flushes ? new Map() : null;
    let reads = 0, cold = 0;
    for (let t = 0; t < n; t++) {
      const k = keys[t], op = ops[t];
      if (op === FLUSH) {
        for (const [db, list] of arrivals) {
          if (k !== -1 && db !== -2 - k) continue;
          for (const x of list) if (last[x] >= 0) { push(last[x]); last[x] = -1; }
          list.length = 0;
        }
        continue;
      }
      const p = last[k];
      if (op === DELETE) {
        if (p >= 0) { push(p); last[k] = -1; }
        continue;
      }
      if (op === READ) {
        reads++;
        if (p < 0) cold++;
        else hist[sum(t - 1) - sum(p)]++;
      }
      const hole = size ? heap[0] : -1;
      if (p >= 0) {
        // A hole above the key takes up the shift, and the key's old place
        // becomes the hole.
        if (hole > p) { pop(); add(hole, -1); push(p); }
        else add(p, -1);
      } else {
        if (hole >= 0) { pop(); add(hole, -1); }
        if (flushes) {
          const db = keyDb ? keyDb[k] : 0;
          let list = arrivals.get(db);
          if (!list) arrivals.set(db, list = []);
          list.push(k);
        }
      }
      add(t, 1);
      last[k] = t;
    }
    // cum[c] = reads served by a cache of c keys.
    const cum = new Float64Array(nKeys + 1);
    let acc = 0;
    for (let d = 0; d < nKeys; d++) { acc += hist[d]; cum[d + 1] = acc; }
    const best = reads - cold;
    const hits = (c) => cum[Math.max(0, Math.min(nKeys, Math.floor(c)))];
    const hitRate = (c) => (reads ? hits(c) / reads : 0);
    const points = [[0, 0]];
    if (nKeys) {
      let c = 1;
      while (c < nKeys) { points.push([c, hitRate(c)]); c = Math.max(c + 1, Math.round(c * 1.08)); }
      points.push([nKeys, hitRate(nKeys)]);
    }
    // The smallest cache that reaches a share of the best possible hit rate.
    const sizeFor = (share) => {
      if (!best) return null;
      const target = best * share;
      let lo = 1, hi = nKeys;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] >= target - 1e-9) hi = mid; else lo = mid + 1; }
      return lo;
    };
    return {
      accesses: n, reads: reads, coldReads: cold, keys: nKeys, best: reads ? best / reads : 0,
      hits: hits, hitRate: hitRate, points: points,
      sizes: [0.5, 0.8, 0.9, 0.95, 0.99].map((s) => ({ share: s, keys: sizeFor(s) }))
    };
  }

  return {
    COMMANDS: COMMANDS,
    commandInfo: commandInfo,
    keyPositions: keyPositions,
    parseLine: parseLine,
    keySlot: keySlot,
    evenSplit: evenSplit,
    guessSeparator: guessSeparator,
    keyPattern: keyPattern,
    showKey: showKey,
    latin1: latin1,
    fromLatin1: fromLatin1,
    analyzer: analyzer,
    lruCurve: lruCurve
  };
});
