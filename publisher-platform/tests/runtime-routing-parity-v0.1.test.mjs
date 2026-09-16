import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness, sources, active, offer } from './runtime-install-browser-v0.1.test.mjs';

// Test-only extraction runs the actual immutable reference functions and candidate
// functions with identical inputs. Neither runtime gets a production testing hook.
function routingFunctions(h, name, config) {
  const source = sources[name];
  const start = source.indexOf('  function normalizePath');
  const end = source.indexOf('  // EVENT DATA');
  const functions = source.slice(start, source.lastIndexOf('  // =========================================================', end));
  return new h.w.Function('CONFIG', `${functions}\nreturn { selectRule, detectChinaTravelIntent, detectProductIntent, calculateProductScore, countKeyword, findOffer, normalizePath };`)(config);
}
const exact = (id, path, product = 'flight') => ({ ...offer(product), id, match: { type: 'path', value: path } });
const scenarios = [
  { name: 'exact rules short-circuit non-content intent and preserve first priority', path: '/exact/', title: 'Unrelated',
    rules: [exact('first', '/exact'), exact('second', '/exact', 'hotel')], product: 'flight', rule: 'first' },
  { name: 'disabled exact rule skipped', path: '/exact', title: 'Unrelated',
    rules: [{ ...exact('disabled', '/exact'), enabled: false }, exact('second', '/exact', 'hotel')], product: 'hotel', rule: 'second' },
  { name: 'non-content gate', path: '/guide', title: 'China travel flights', product: null },
  { name: 'post slash gate', path: '/post', title: 'China travel flights', product: null },
  { name: 'post prefix gate', path: '/posts/guide', title: 'China travel flights', product: null },
  { name: 'no China intent', title: 'Europe travel flights', product: null },
  { name: 'intent score below four', title: 'China vacation', product: null },
  { name: 'intent score at four', title: 'China vacation itinerary', product: 'hotel' },
  { name: 'generic hotel fallback', title: 'China travel guide', product: 'hotel' },
  { name: 'strong flight title', title: 'China travel flight', product: 'flight' },
  { name: 'strong hotel title', title: 'China travel hotel', product: 'hotel' },
  { name: 'plural substring weighting', title: 'China travel flights', product: 'flight' },
  { name: 'tie goes to generic hotel', title: 'China travel flight hotel', product: 'hotel' },
  { name: 'strong meta', title: 'China travel guide', meta: 'airfare', product: 'flight' },
  { name: 'weak body below threshold', title: 'China travel guide', body: 'flight flight flight flight', product: 'hotel' },
  { name: 'body repeated plurals reach six', title: 'China travel guide', body: 'flights flights flights', product: 'flight' },
  { name: 'paragraph body limit', title: 'China travel guide', body: 'x'.repeat(15000) + ' flights flights flights', product: 'hotel' },
  { name: 'first usable offer ordering', title: 'China travel hotel', offers: [offer('hotel', '_first'), offer('hotel', '_second')], product: 'hotel', selected: 'hotel_first' },
  { name: 'disabled offer skipped', title: 'China travel hotel', offers: [{ ...offer(), enabled: false }, offer('hotel', '_second')], product: 'hotel', selected: 'hotel_second' },
  { name: 'no product substitution when selected offer missing', title: 'China travel flights', offers: [offer()], product: null },
  { name: 'exact priority over strong flight intent', title: 'China travel flights', rules: [exact('hotel-first', '/post/guide', 'hotel')], product: 'hotel', rule: 'hotel-first' }
];
for (const scenario of scenarios) test(`v0.4 route parity: ${scenario.name}`, async t => {
  const config = active(); config.rules = scenario.rules || []; config.offers = scenario.offers || config.offers;
  const h = await harness({ config, title: scenario.title, meta: scenario.meta, body: scenario.body,
    url: `https://publisher.test${scenario.path || '/post/guide'}` }); t.after(() => h.close());
  const legacy = routingFunctions(h, 'chinaflow-v0.4.js', config), candidate = routingFunctions(h, 'chinaflow-v0.6.js', config);
  const a = legacy.selectRule(), b = candidate.selectRule(); assert.deepEqual(b, a);
  assert.equal(b?.product || null, scenario.product);
  if (scenario.rule) assert.equal(b.rule_id, scenario.rule);
  if (scenario.selected) assert.equal(b.offer_id, scenario.selected);
  await h.tick(); assert.equal(Boolean(h.cta()), Boolean(a));
  if (a) assert.equal(h.cta().querySelector('a').href, a.url); h.noFallback();
});
test('v0.4 keyword weights, body cap, threshold six and margin two boundaries', async t => {
  const h = await harness({ auto: false }); t.after(() => h.close());
  const legacy = routingFunctions(h, 'chinaflow-v0.4.js', active()), candidate = routingFunctions(h, 'chinaflow-v0.6.js', active());
  for (const [flight, hotel, expected] of [[5, 0, 'hotel'], [6, 0, 'flight'], [6, 3, 'flight'],
    [6, 4, 'hotel'], [6, 6, 'hotel'], [9, 6, 'flight'], [8, 6, 'hotel'], [0, 6, 'hotel']]) {
    // Distinct body keywords each cap at three; thus exact integer score fixtures.
    const make = (n, a, b, c) => [a.repeat(Math.min(n, 3)), b.repeat(Math.min(Math.max(n - 3, 0), 3)), c.repeat(Math.max(n - 6, 0))].join(' ');
    const context = { strongText: '', body: make(flight, 'flight ', 'airfare ', 'flying ') + make(hotel, 'hotel ', 'resort ', 'where to stay ') };
    const a = legacy.detectProductIntent(context), b = candidate.detectProductIntent(context);
    assert.deepEqual(b, a); assert.equal(b.scores.flight, flight); assert.equal(b.scores.hotel, hotel); assert.equal(b.product, expected);
  }
  for (const strongText of ['', 'flight', 'flights flights', 'air tickets']) {
    const context = { strongText, body: 'flight '.repeat(20) };
    assert.deepEqual(candidate.detectProductIntent(context), legacy.detectProductIntent(context));
    assert.equal(candidate.calculateProductScore(context, ['flight']), legacy.calculateProductScore(context, ['flight']));
  }
  assert.equal(candidate.calculateProductScore({ strongText: 'flight', body: 'flight '.repeat(50) }, ['flight']), 9);
});
for (const width of [600, 601, 1000]) test(`full DOM CTA v0.4 parity at width ${width}`, async t => {
  const config = active();
  const legacy = await harness({ config, auto: false, width }); t.after(() => legacy.close());
  legacy.execute('chinaflow-v0.4.js'); await legacy.tick(1700);
  const candidate = await harness({ config, width }); t.after(() => candidate.close()); await candidate.tick();
  const old = legacy.cta(), current = candidate.cta(); assert(old); assert(current);
  // Internal publisher identity is intentionally omitted; all user-facing DOM,
  // inline style declarations, CTA copy and anchor navigation attributes match.
  const oldCopy = old.cloneNode(true); oldCopy.removeAttribute('data-publisher');
  assert.equal(current.outerHTML, oldCopy.outerHTML);
  const link = current.querySelector('a'); assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener sponsored');
  assert.equal(current.parentElement, candidate.d.body); assert.equal(current.style.position, 'fixed');
  assert.equal(current.style.bottom, width <= 600 ? '14px' : '26px');
  assert.equal(link.style.minHeight, width <= 600 ? '72px' : '82px');
  link.dispatchEvent(new candidate.w.Event('mouseenter')); assert.equal(link.style.transform, 'translateY(-3px)');
  link.dispatchEvent(new candidate.w.Event('mouseleave')); assert.equal(link.style.transform, 'translateY(0)');
  const click = new candidate.w.Event('click', { cancelable: true }); assert.equal(link.dispatchEvent(click), true);
  assert.equal(click.defaultPrevented, false); candidate.noFallback();
});
