# cowboy — what is on its way

Links out of a box and between boxes, decided where the box runs, so that almost all of it is done on the device
and what a service is left to do costs next to nothing. Rust, with no library and nothing allocated; as wasm where
a box runs in a page (6.5 kB, importing nothing).

A link is a stream of bytes between two ends. A box's sockets are calls (sods answers them), so there are no
packets here: no TCP to run a second time, no frame to parse on the way. What cowboy does is decide how each link
is made, and it asks no one to decide it.

```
src/names.rs     a name asked for (DNS) is answered here, with an address of cowboy's own kept beside the name
src/route.rs     which way a link to an address is made: to the name it was given for, or to it as it stands
src/frame.rs     what goes over a relay: one line of where to, one byte back, then nothing but the bytes
src/lib.rs       the three calls a host makes of it as wasm, over one piece of memory
host/outside.ts  cowboy where a box runs on sods' Linux: what answers for the outside of the machine's network
host/relay.ts    a link carried by a relay, from a page: one WebSocket a link
test/            the root's own curl on sods' Linux in node, reaching a server by its name through cowboy
```

```
cargo test                                                     its Rust, by itself
cargo build --release --target wasm32-unknown-unknown          as a box's host loads it
node --test test/*.test.ts                                     with a real program (needs public/webroot)
```

## How a link is made

| A link to | Made by | A service does |
| --- | --- | --- |
| a name (DNS) | cowboy answers itself: each name asked for is given an address of cowboy's own (198.18.0.0/15, on no network a box would reach), and the same one after; the address is the name's place in its table. No resolver is asked | nothing |
| the machine itself | the machine (sods' loopback): it never comes here | nothing |
| a host, by a name cowboy gave an address to | the link is dialled by that name, not by the address: whoever carries it finds where the name is | copies bytes, where a relay carries it: no judgement, nothing kept past the connection |
| a host, by its address | dialled as it stands | the same |

The host hands in what carries a link (`dial`): in node a socket; in a page a relay's WebSocket (`host/relay.ts`).
What is said over a relay is sealed between the box and the host it reaches (TLS, SSH): the relay reads none of
it. sods lends the port it is given at (`linux({outside})`), as it lends a tree, and knows nothing of who answers;
a box has it only where it was lent the machine's network (a network namespace of its own has its loopback alone).

## Its bounds

Counted by hand, held by its tests.

| Its work | Bound |
| --- | --- |
| a name answered | its bytes read once (made lower case, hashed and kept in that one pass, in the room after the last name kept); one slot looked at where the table is not crowded (at most half its slots are ever taken: under two on average, full); the answer written once: the query's own bytes and sixteen more |
| an address named | one index |
| a link's first line | the name's bytes and its port's digits, written once |
| memory | laid out once (4,096 slots, 2,048 names, 131,072 bytes of them), asked for never |
| a link's bytes | not cowboy's to copy: they go between the stream's own pipes (sods) and the link (the host); what one side cannot take yet is all that waits |

## Not yet

- A page is not given it: the Worker that runs the root takes no outside yet, and no relay is served (shipto's:
  who may use it, to where, how much).
- A link between boxes on two devices (a channel between them, the Remote saying only where each is).
- A host that answers a page itself (HTTP with CORS) reached by the page's own request, with no relay.
- IPv6.
