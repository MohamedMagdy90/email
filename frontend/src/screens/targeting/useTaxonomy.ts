// The targeting taxonomy (industries, countries + cities, size bands, title
// presets), fetched once per page load and shared by every targeting screen.
import { useEffect, useState } from "react";
import { toast } from "../../lib/ui";
import { targetingApi, type Taxonomy } from "../../lib/v2/targeting";
import { errMsg } from "../campaigns/parts";

let taxPromise: Promise<Taxonomy> | null = null;

export function useTaxonomy(): Taxonomy | null {
  const [tax, setTax] = useState<Taxonomy | null>(null);
  useEffect(() => {
    if (!taxPromise) taxPromise = targetingApi.taxonomy().catch((e) => ((taxPromise = null), Promise.reject(e)));
    let alive = true;
    taxPromise.then((t) => alive && setTax(t)).catch((e) => toast(errMsg(e), "error"));
    return () => {
      alive = false;
    };
  }, []);
  return tax;
}
