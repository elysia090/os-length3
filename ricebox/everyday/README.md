# everyday — display and input compatibility

The intended role is a display/input compatibility foundation using existing Wayland
components: ordinary windows through xdg-shell, panels and other desktop surfaces
through layer-shell, with foot, Waybar, fuzzel, mako, wallpaper clients and Quickshell
as compatibility targets. Prefer existing session/compositor behavior and add only a
proven missing connection. The intended ricebox integration includes the foundation, not a new ricebox UI or
every application by default. everyday remains independently usable.

This target is **not implemented by the current theme parser**. Native borrowed-session
and non-native execution are different paths, with different proof obligations. The
first profile and its acceptance gates are in [DISPLAY-INPUT.md](DISPLAY-INPUT.md).
Neither the terminal artwork experiment nor a theme change establishes compatibility.

## Current implementation: theme values

The following describes the existing theme-value API, retained for its current callers.
It is not the definition or completion criterion of the display/input foundation.

ricebox has no window of its own. It has this: the layer a face is drawn through, so that whatever face it is
given (why's pages, a terminal, someone's own), its look is one thing, said one way, and the person's to change.

A look is a sheet: names and their values (a stylesheet's custom properties: colours, faces, sizes, spaces,
corners, the pace of what moves). A person's changes are a few lines in a file of their own:

```
# ~/.everyday
ground: #e9e4d8
ink: #1c1b19
sans: Atkinson Hyperlegible
pace: 0.5
```

everyday reads the sheet for what may be changed, holds the lines to it, and gives the face one rule that makes
them so. That is the present implementation (`src/everyday.ts`: `things`, `change`).

**It knows no product, and no product is broken through it.** It depends on nothing and is told nothing of what a
face is for. A person may change nearly everything a look is made of, and whatever they write, the face they
changed still does everything it did: what comes out of everyday is values for names the face's own sheet already
has, each of its kind and within its bounds, with every word still read on its ground. No rule of the person's
own, no selector, no script, nothing the face did not already draw with.

- **What may be changed is what the sheet says once, plainly, for every window.** A colour, a length, a time, a
  number, a share, a face. A value made of others (`var()`, `calc()`, a mix) follows them; one the sheet itself
  changes by the window is the sheet's. Nothing is listed anywhere else: the sheet a face is drawn from is the
  list, and `node src/list.ts SHEET...` prints it, each with what the sheet says of it.
- **Each change is held to its kind and to bounds.** A colour is `#rgb` or `#rrggbb`. A length is between half
  and twice what it was; a time from none to four times; a number from a quarter to four times; a share from none
  to all. A face is its families' names, and the sheet's own come after it, for the letters it has not.
- **Words stay read.** A face says which words stand on which grounds. The look is read as a whole (a dark
  ground and light words are taken together, in either order); while a pair would not be read, the line written
  last among those that changed it is left out.
- **A line that is wrong is left out and said, and the rest stands.** What it would have changed stays as it was.
  Nothing a person wrote is put in the rule as it came: each value is read, and written again from what was read.
- **The way back is the file.** A line taken out is that thing as it was; no file is everything as it was. There
  is no state besides it, nothing to reset, nothing to migrate.

```
node src/list.ts SHEET...                    what may be changed: name, kind, usual value, how far it may go
node src/list.ts --changes FILE SHEET...     the rule FILE's lines make, and each line left out, with why
node --test test/everyday.test.ts
```

## Beside a compositor's config

What a person changes a look by, elsewhere, is a program's settings: hundreds of words, each with a grammar of
its own, some checked and some not, their usual values in a manual, the way back a copy kept by hand. Here the
words are the sheet's own, so there are exactly as many as the look has values; a value has one of six kinds and
is checked as that; the usual value is the sheet's; and the way back is to take the line out.

## In why

why's pages are one face. Their sheets are `why/app/styles`; what of them may be changed is written into the
app by `why/build/styles/look.ts` (`why/app/ui/look-things.ts`), and a person's lines are the dotfile `.everyday`, kept
and brought to each device as every dotfile is (Runtime shows and edits it). `why/app/ui/look.ts` wears it, with
the words that must stay read on the OS's grounds, including the active Prompt's
text against its background. The editor shows which lines this file cannot apply
and why, without removing them from the file or taking changes from another device.
Nothing of why is known here.

## Embed one guest surface (opt-in)

`ricebox/everyday` is a host-side 2D canvas presenter, not a compositor or a
guest launch API. Admit an existing guest surface explicitly through a
`GuestSurfaceSource`. That source belongs to the deployer: it subscribes to one
agreed surface, supplies its frames, and optionally accepts primary-pointer
contacts and explicit guest resize requests. The presenter does not open a
socket, start or retire a Worker, fetch packages, or expose a mirrored directory.
Importing it does not change the default Ricebox startup.

```html
<div id="camera" style="width: 24rem; height: 14rem; overflow: auto">
  <canvas id="guest" style="display: block"></canvas>
</div>
```

```ts
import {mountGuestSurface, type GuestSurfaceSource} from 'ricebox/everyday';

// The application has already agreed on one guest surface and owns its source.
export function show(source: GuestSurfaceSource) {
  const viewport = document.querySelector<HTMLElement>('#camera')!;
  const canvas = document.querySelector<HTMLCanvasElement>('#guest')!;
  const surface = mountGuestSurface({source, viewport, canvas,
    limits: {width: 1920, height: 1080, bytes: 1920 * 1080 * 4}});

  viewport.scrollTo(40, 20); // Host camera only. No guest event is sent.
  return surface;           // Opt in to surface.resize(w, h); close on teardown.
}
```

The source lends tightly packed, straight RGBA pixels (red, green, blue, alpha;
four bytes per pixel) for each synchronous `observer.frame()`. Release or reuse
the buffer after the call returns; the presenter does not retain it. Each source
starts with a positive serial and publishes strictly newer serials. A stale,
incomplete, oversized or shared-memory frame is refused. Define frame limits
before materializing decoded pixels as well; the presenter does not bound
transport or decoder allocations. If the admitted source ends it calls
`observer.end()`; `surface.close()` also removes the subscription and input hook,
but does not shut down the caller's transport. The canvas is exclusive to the
mount while attached.

The browser owns scrolling, clipping and CSS sizing of the borderless canvas
in its untransformed, axis-aligned viewport. Pointer coordinates are browser CSS
pixels measured at each contact, mapped only inside both the canvas and the
viewport's content area (excluding borders and scrollbars). The optional source
input carries the rendered serial, so a source can reject input for a surface
that has already changed. No keyboard, hover or blanket input forwarding is
implied. A browser layout resize is not a guest resize.

The [static guest Wayland browser example](test/wayland/browser/demo.mts) uses
this entry from a locally installed Ricebox tarball. It owns the Worker and
admits only the fixture surface published from an actual Wayland SHM commit.
The example's file encoding and input bytes stay test-only; they are not the
package's surface protocol. This is not stock Quickshell running in Sods.

### Bind a surface already lent by a Ricebox Worker

For a deployer who already owns a Ricebox root Worker, `surfaceFromMirror`
adapts one root-level file in that Worker's configured mirror. Give the guest
a dedicated mirror directory for display output. The Worker sends its ordinary
`changes` messages, and the adapter selects only the agreed basename. There is
no extra mount, polling, default frame format or permission. Attach before
starting the guest: mirroring is change-based, not a snapshot or video stream.

```ts
import {mountGuestSurface, surfaceFromMirror} from 'ricebox/everyday';

// worker and admittedStart are owned and prepared by the application.
// The producer agrees on scanout.bin in the guest's dedicated mirror directory.
const source = surfaceFromMirror({
  worker, file: 'scanout.bin', maxEncodedBytes: 2 * 1024 * 1024,
  decode: decodeProducerFrame, // your bounded synchronous format-to-GuestFrame decoder
});
const surface = mountGuestSurface({canvas, viewport, source,
  limits: {width: 1024, height: 768, bytes: 1024 * 768 * 4}});
worker.postMessage({...admittedStart, mirror: '/display-out'});
// Call surface.close() before terminating this Worker yourself.
```

The optional `encodePointer` and `encodeResize` handlers return bytes for the
same Worker's existing guest stdin. Omit them for a display-only embed. Use
them only if stdin belongs to this display's agreed controls, not a shell or
another app. Input must name the current drawn serial and coordinates are
bounded; a malformed, stale or rejected change to the selected file disarms
input until a valid newer frame is drawn. Publish complete images atomically;
an invalid update can leave the old pixels visible but not interactive.
Removing or replacing the selected file with a directory, Worker exit,
retirement or error ends this one-shot observation. Unsubscribing does not
stop the Worker, and browsers do not send an event for an owner calling
`Worker.terminate()`, so close your mount before doing so.

The encoded-byte budget is checked before decoding. The caller must bound
the producer, the existing mirror and decoded geometry; messages and their
bytes already exist when the adapter gets them. See the
[static guest Wayland test](test/wayland/README.md) for the pinned producer
and [browser run](test/wayland/browser/README.md). That example supplies its
own test-only file decoder and pointer/resize packets. The package does not
install a Wayland compositor or launch stock Quickshell in Sods.

The [optional same-page shell example](test/wayland/browser/composition.md)
runs a second real guest independently. A shell asset is only requested when
opened; the display and shell do not share stdin, a guest or retirement.
