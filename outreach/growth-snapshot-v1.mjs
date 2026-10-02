const DEFAULT_CAMPAIGN="round2-zh-20260928";
function s(v){return String(v??"").trim();}
function pct(n,d){return d>0?Number((100*n/d).toFixed(2)):null;}
export function deriveOutreachGrowth(values,{campaign=DEFAULT_CAMPAIGN}={}){
  if(!Array.isArray(values)||values.length<1) throw new Error("invalid pipeline values");
  const rows=values.slice(1).filter(r=>s(r[26])===campaign);
  const sent=rows.filter(r=>s(r[28])==="Sent").length;
  const prepared=rows.filter(r=>s(r[28])==="Prepared").length;
  const suppressed=rows.filter(r=>s(r[28])==="Suppressed").length;
  const permanentFailures=rows.filter(r=>["Invalid Email","Delivery Failed"].includes(s(r[16]))).length;
  const deliveredEstimate=Math.max(0,sent-permanentFailures);
  const humanSignals=rows.filter(r=>/^Human reply\b/i.test(s(r[21]))||s(r[16])==="Referral Opportunity").length;
  return {campaign,prospects:rows.length,sent,prepared,suppressed,permanentFailures,deliveredEstimate,humanSignals,bounceRatePct:pct(permanentFailures,sent),humanSignalRatePct:pct(humanSignals,deliveredEstimate)};
}
export function buildGrowthSnapshot({sheetValues,d1Summary,d1Currencies,generatedAt=new Date().toISOString(),campaign=DEFAULT_CAMPAIGN}){
  const outreach=deriveOutreachGrowth(sheetValues,{campaign});
  const d=d1Summary??{};
  const registeredFromOutreach=Number(d.outreach_bound_publishers??0);
  const outreachClickedProspects=Number(d.outreach_clicked_prospects??0);
  return {
    version:1,generatedAt,
    acquisition:{...outreach,outreachClickedProspects,outreachClicks:Number(d.outreach_clicks??0),funnelEligibleClickedProspects:Number(d.funnel_eligible_clicked_prospects??0),outreachLoginProspects:Number(d.outreach_login_prospects??0),outreachLoginArrivals:Number(d.outreach_login_arrivals??0),outreachMagicLinkRequestedProspects:Number(d.outreach_magic_link_requested_prospects??0),outreachMagicLinkConsumedProspects:Number(d.outreach_magic_link_consumed_prospects??0),registeredFromOutreach,outreachClickRatePct:pct(outreachClickedProspects,outreach.deliveredEstimate),clickToLoginPct:pct(Number(d.outreach_login_prospects??0),Number(d.funnel_eligible_clicked_prospects??0)),loginToMagicRequestPct:pct(Number(d.outreach_magic_link_requested_prospects??0),Number(d.outreach_login_prospects??0)),magicRequestToConsumedPct:pct(Number(d.outreach_magic_link_consumed_prospects??0),Number(d.outreach_magic_link_requested_prospects??0)),consumedToRegistrationPct:pct(registeredFromOutreach,Number(d.outreach_magic_link_consumed_prospects??0)),outreachToRegistrationPct:pct(registeredFromOutreach,outreach.deliveredEstimate)},
    activation:{registeredPublishers:Number(d.publishers??0),activePublisherAccounts:Number(d.active_publishers??0),activePlacements:Number(d.active_placements??0),publisherCtaClicks:Number(d.publisher_cta_clicks??0),clickActivePublishers30d:Number(d.click_active_publishers_30d??0)},
    commerce:{matchedBookings:Number(d.matched_bookings??0),successfulMatchedBookings:Number(d.successful_matched_bookings??0),bookingPublishers30d:Number(d.booking_publishers_30d??0),matchedCommissionFacts:Number(d.matched_commission_facts??0),commissionPublishers30d:Number(d.commission_publishers_30d??0),netRevenuePublishers30d:Number(d.net_revenue_publishers_30d??0),earningsPublishers30d:Number(d.earnings_publishers_30d??0),latestCompletedIngestionAt:d.latest_completed_ingestion_at??null,currencies:Array.isArray(d1Currencies)?d1Currencies:[]},
    health:{hasAcquisitionData:outreach.sent>0,hasActivationData:Number(d.publisher_cta_clicks??0)>0,hasBookingData:Number(d.matched_bookings??0)>0,hasRevenueData:Number(d.net_revenue_publishers_30d??0)>0}
  };
}
