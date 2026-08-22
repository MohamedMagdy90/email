# Search-engine bake-off

Measured from this container's datacenter IP while fixing the "web search returns
rubbish" incident. Everything here is measured, not inferred.

## Verdict

**No new engine is needed, and none of the candidates would have helped.**

The pool was never short of a good engine. It was that the *bad* engine answered
instantly and was trusted, so it won the rotation every time and crowded the good
ones out. Once results are verified against the query, the existing pool plus the
reader delivers **41/41 on-target** for the exact keywords that previously
returned 0.

## Candidates tested

| Engine | Endpoint | Result |
|---|---|---|
| bing-rss | `bing.com/search?…&format=rss` | 200, **silently degraded** — see below |
| bing-html | `bing.com/search?…` | 200, same degradation, **fake pagination** (`first=1/11/21/31/41` → identical 10) |
| duckduckgo | `html.duckduckgo.com/html/?q=` | intermittent wall; **obeys `site:` when it answers** |
| duckduckgo-lite | `lite.duckduckgo.com/lite/?q=` | same wall; POST → HTTP 202 challenge |
| brave | `search.brave.com/search?q=` | HTTP 429 |
| mojeek | `mojeek.com/search?q=` | HTTP 403 on every UA (Chrome, Firefox, curl, empty) |
| yep | `api.yep.com/fs/2/search` | HTTP 403 |
| ecosia | `ecosia.org/search?q=` | HTTP 403 |
| stract | `stract.com/search?q=` | HTTP 404 |
| searx.be | `searx.be/search?…&format=json` | walled |
| priv.au | `priv.au/search?q=` | real page, but `<meta name="endpoint" content="captcha">` |
| search.inetol.net | `search.inetol.net/search?q=` | results page with **zero results**; `format=rss`/`json` → 403; then 429 |
| searxng.site | `/searxng/search?q=` | index page only |
| **jina reader** | `r.jina.ai/<url>` | **works keyless**, obeys `site:`, renders a real SERP |

## The refined Bing diagnosis

Bing does not block — it **degrades silently**: HTTP 200, ten plausible results,
with the `site:` operator, the city and the country all discarded, answering only
the head noun. There is no captcha and no 429, so nothing in the old code could
detect it.

It is **keyword-dependent, not shape-dependent**. Measured across five head terms
× five query shapes:

```
kw site:.qa              0/47 hits on .qa · honoured 0/5
"kw" site:.qa            0/47 · honoured 0/5
kw Qatar site:.qa        0/47 · honoured 0/5
kw Doha site:.qa         0/47 · honoured 0/5
kw contact site:.qa      0/47 · honoured 0/5
```

No phrasing rescues it. Yet `MEP contractor site:.qa` returns 10/10 correct,
repeatedly. Bing relaxes the operator for common head terms and honours it for
distinctive ones — and the behaviour also drifts over time (1/18 honoured in one
run, 1/3 in another).

Cookies make no difference: a 12-cookie jar from the Bing homepage scored
identically to no cookies (10/30 both). `&setmkt=en-QA&cc=QA` made it actively
**worse** — it returned `firsttechfed.com`, a US credit union.

Because it cannot be predicted, it can only be **checked**. That is what
`hitSatisfies` does.

## Why the fix works without a new engine

`freeSerp` rotates the pool and returns the first engine whose results *survive
verification*. Bing's garbage is now rejected, so the rotation falls through to
DuckDuckGo, and past that to the reader. Verified end to end on the five keywords
Bing scored 0/47 on:

```
steel fabrication              duckduckgo  10/10   wellguard.qa, etihadsteel.qa, steelart.qa
construction company           duckduckgo   8/8    contraco.com.qa, qbsc.qa, hbngroup.com.qa
packaging materials company    reader       7/7    proplastic.com.qa, dandy.qa, premierplastic.qa
electrical equipment supplier  reader       8/8    sterlingtrading.qa, qatcon.qa, setco.qa
facilities management company  reader       8/8    versus.qa, fmm.com.qa, primez.qa
                                          -----
                                           41/41 on target
```

DuckDuckGo is **not** permanently walled — it walls under hammering and recovers
with polite pacing, which the per-engine pacer already enforces. Its earlier 0/18
was an artefact of probing, not a production condition.

## Recommendation

Do not add engines. Two things matter instead:

1. **Keep the verifier strict.** It is what turns an unreliable pool into a
   reliable one.
2. **Add a free Jina key** (Settings → Crawler). The reader answered 3 of the 5
   queries above and is the tier that carries a pass when Bing is lying and
   DuckDuckGo is resting. It works keyless but is rate-limited.
