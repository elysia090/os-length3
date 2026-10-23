// When the app cannot start (its script fails to load, or fails as it runs in a browser that lacks
// something it needs), the page says so: what failed, in which browser, and a way to try again, rather
// than a blank page that says nothing. Plain ES5 and no module, so it runs where the app itself cannot;
// a file of its own, as the page's policy runs no script written into the page.
(function () {
  // Scripts run: what index.html says for a page whose scripts never run is not shown (styles.css).
  document.documentElement.className += ' scripted';
  var failed = [];
  window.addEventListener('error', function (e) {
    var t = e.target;
    // A script or stylesheet that did not load is said by its file; an error thrown, by its words and place.
    if (t && t !== window && (t.src || t.href)) failed.push('could not load ' + String(t.src || t.href).split('/').pop());
    else failed.push((e.message || 'an error') + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ':' + e.colno + ')' : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    failed.push(r && r.message ? r.message : String(r));
  });
  // The app draws the rail as its script runs, and its script has run once the page has loaded.
  function started() {
    var tabs = document.getElementById('rail-tabs');
    return !!(tabs && tabs.children.length) || !document.getElementById('rail-tabs');
  }
  function say() {
    if (started()) return;
    var ja = /^ja\b/.test(navigator.language || '');
    var page = document.getElementById('page') || document.body;
    var box = document.createElement('section');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'max-width:34rem;margin:15vh auto 0;padding:0 1rem;font:16px/1.5 system-ui,sans-serif';
    var h = document.createElement('h1');
    h.style.cssText = 'font-size:1.4rem;margin:0 0 .5rem';
    h.textContent = ja ? 'Length³ OS を開けませんでした' : 'Length³ OS could not start';
    var p = document.createElement('p');
    p.textContent = ja ? 'このブラウザで止まった箇所です。報告のときはこの画面をそのまま送ってください。' : 'This is where it stopped in this browser. To report it, send this screen as it is.';
    var pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font:13px/1.4 ui-monospace,monospace;padding:.75rem;border:1px solid currentColor;border-radius:8px;opacity:.85';
    // Which build this is (vite.config.ts), so a report says which deploy it came from.
    var build = document.querySelector('meta[name="length3-build"]');
    pre.textContent = (failed.length ? failed.join('\n') : (ja ? '(エラーは届いていません)' : '(no error was reported)')) + '\n\n' + navigator.userAgent
      + (build ? '\nLength³ OS ' + build.getAttribute('content') : '');
    var again = document.createElement('button');
    again.type = 'button';
    again.style.cssText = 'margin-top:1rem;padding:.5rem 1.25rem;border-radius:999px;border:1px solid currentColor;background:none;font:inherit;color:inherit';
    again.textContent = ja ? '再読み込み' : 'Try again';
    again.onclick = function () { location.reload(); };
    box.appendChild(h); box.appendChild(p); box.appendChild(pre); box.appendChild(again);
    page.removeAttribute('aria-busy');
    page.appendChild(box);
  }
  window.addEventListener('load', function () { setTimeout(say, 1500); });
})();
