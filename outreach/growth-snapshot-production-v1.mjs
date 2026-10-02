import {execFileSync} from "node:child_process";
import {createProductionAdapters} from "./production-adapters-v1.mjs";
import {buildGrowthSnapshot} from "./growth-snapshot-v1.mjs";
const DB="chinaflow-events-v0-1", CONFIG="collector/wrangler.production.jsonc";
function sleep(ms){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}
function assertSelect(sql){const q=sql.trim();if(!/^SELECT\b/i.test(q)||q.slice(0,-1).includes(";"))throw new Error("growth query must be single SELECT");return q;}
export function createGrowthD1Reader({execFile=execFileSync,retries=3}={}){
  return sql=>{
    const q=assertSelect(sql);let last;
    for(let i=0;i<retries;i++){
      try{
        const raw=execFile("npx",["--no-install","wrangler","d1","execute",DB,"--remote","--config",CONFIG,"--yes","--json","--command",q],{encoding:"utf8",maxBuffer:4*1024*1024});
        const parsed=JSON.parse(raw), first=Array.isArray(parsed)?parsed[0]:parsed;
        if(first?.success!==true||!Array.isArray(first.results)) throw new Error("D1 growth query failed");
        return first.results;
      }catch(e){last=e;if(i<retries-1)sleep(2000);}
    }
    throw last;
  };
}
const SUMMARY_SQL=`SELECT
 (SELECT count(*) FROM publishers) AS publishers,
 (SELECT count(*) FROM publishers WHERE account_status='active') AS active_publishers,
 (SELECT count(*) FROM publisher_placements WHERE is_active=1) AS active_placements,
 (SELECT count(*) FROM outreach_attributions WHERE campaign='round2-zh-20260928' AND click_count>0) AS outreach_clicked_prospects,
 (SELECT coalesce(sum(click_count),0) FROM outreach_attributions WHERE campaign='round2-zh-20260928') AS outreach_clicks,
 (SELECT count(*) FROM outreach_attributions WHERE campaign='round2-zh-20260928' AND publisher_id IS NOT NULL) AS outreach_bound_publishers,
 (SELECT count(*) FROM events WHERE event_type='cta_click') AS publisher_cta_clicks,
 (SELECT count(DISTINCT publisher_id) FROM events WHERE event_type='cta_click' AND datetime(occurred_at)>=datetime('now','-30 days')) AS click_active_publishers_30d,
 (SELECT count(*) FROM trip_bookings WHERE attribution_status='matched') AS matched_bookings,
 (SELECT count(*) FROM trip_bookings WHERE attribution_status='matched' AND normalized_order_status='successful') AS successful_matched_bookings,
 (SELECT count(DISTINCT attributed_publisher_id) FROM trip_bookings WHERE attribution_status='matched' AND normalized_order_status='successful' AND date(order_date)>=date('now','-29 days')) AS booking_publishers_30d,
 (SELECT count(*) FROM trip_commissions WHERE attribution_status='matched') AS matched_commission_facts,
 (SELECT count(DISTINCT attributed_publisher_id) FROM trip_commissions WHERE attribution_status='matched' AND date(order_date)>=date('now','-29 days')) AS commission_publishers_30d,
 (SELECT count(DISTINCT publisher_id) FROM publisher_net_commission_revenue_entries WHERE datetime(effective_at)>=datetime('now','-30 days')) AS net_revenue_publishers_30d,
 (SELECT count(DISTINCT publisher_id) FROM publisher_earnings_entries WHERE datetime(effective_at)>=datetime('now','-30 days')) AS earnings_publishers_30d,
 (SELECT max(completed_at) FROM report_ingestion_runs WHERE status='completed') AS latest_completed_ingestion_at`;
const CURRENCY_SQL=`SELECT metric,currency,rows,amount_micros FROM (
 SELECT 'successful_booking_gmv' AS metric,currency,count(*) AS rows,coalesce(sum(booking_amount_micros),0) AS amount_micros FROM trip_bookings WHERE attribution_status='matched' AND normalized_order_status='successful' GROUP BY currency
 UNION ALL SELECT 'supplier_commission',currency,count(*),coalesce(sum(commission_amount_micros),0) FROM trip_commissions WHERE attribution_status='matched' GROUP BY currency
 UNION ALL SELECT 'net_commission_revenue',currency,count(*),coalesce(sum(net_commission_revenue_micros),0) FROM publisher_net_commission_revenue_entries GROUP BY currency
 UNION ALL SELECT 'publisher_earnings',earnings_currency,count(*),coalesce(sum(publisher_earnings_micros),0) FROM publisher_earnings_entries GROUP BY earnings_currency
) ORDER BY metric,currency`;
export async function runProductionGrowthSnapshot({pipeline=createProductionAdapters(),d1=createGrowthD1Reader(),now=new Date()}={}){
  const sheetValues=await pipeline.readPipelineValues();
  const summary=d1(SUMMARY_SQL)[0]??{};
  const currencies=d1(CURRENCY_SQL);
  return buildGrowthSnapshot({sheetValues,d1Summary:summary,d1Currencies:currencies,generatedAt:now.toISOString()});
}
