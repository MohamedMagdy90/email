// VERIFICATION — the "trading" collision guard. Deleted after the run.
import { isNonProspectHost } from "../src/search";

// Every one of these came out of a REAL Qatar pass on
// "trading and contracting W.L.L." before the guard existed.
const platforms = [
  "trading212.com", "etrade.com", "metatrader5.com", "olymptrade.com",
  "wrtrading.com", "simul8or.com", "yandex.com", "etoro.com",
  "binance.com", "tradingview.com", "investing.com", "plus500.com",
  "exness.com", "avatrade.com", "coinbase.com",
];
// Real Gulf firms found in the same pass — these must survive.
const companies = [
  "alsraiyagroup.com", "naharalrayyan.com", "alraen.com", "abhcontracting.com.qa",
  "aamal.com.qa", "targetmep-qa.com", "mepcontracting.net", "qmepqatar.com",
  "almalkiholding.com", "albahartrading.com", "aladraq.com", "constructwll.com",
  "arabedgeqa.com", "alhadab.com.sa", "connect.com.qa",
];

let bad = 0;
for (const h of platforms) if (!isNonProspectHost(h)) { console.log(`  ✗ NOT blocked: ${h}`); bad++; }
for (const h of companies) if (isNonProspectHost(h)) { console.log(`  ✗ wrongly blocked: ${h}`); bad++; }
console.log(
  bad === 0
    ? `  ✓ ${platforms.length} trading platforms blocked · ${companies.length} real companies kept`
    : `  ${bad} FAILURES`
);
process.exit(bad === 0 ? 0 : 1);
