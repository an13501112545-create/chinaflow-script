const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const OUR_ACCOUNT = "chris.an@getchinaflow.com";

function clean(value) { return String(value ?? "").trim(); }
function lower(value) { return clean(value).toLowerCase(); }
function emailDomain(value) { const s=lower(value); const i=s.lastIndexOf("@"); return i>0?s.slice(i+1):""; }
function websiteHost(value) {
  try { return new URL(clean(value)).hostname.toLowerCase().replace(/^www\./,""); }
  catch { return ""; }
}
function extractEmails(text) { return [...new Set((String(text??"").match(EMAIL_RE)||[]).map(x=>x.toLowerCase()))]; }

function isDaemon(sender) {
  const s=lower(sender);
  return s.includes("mailer-daemon") || s.includes("postmaster") || s.includes("mail delivery subsystem");
}

export function classifyInboundMessage(message) {
  const senderEmail=lower(message?.sender_email);
  const subject=clean(message?.subject);
  const body=clean(message?.body);
  const combined=`${subject}\n${body}`;
  if (isDaemon(senderEmail) || isDaemon(message?.sender_name)) {
    const targets=extractEmails(body).filter(x=>x!==OUR_ACCOUNT && !x.includes("mailer-daemon") && !x.includes("postmaster"));
    const delay=/delay|warning message only|will be retried|retry for\s+\d+/i.test(combined);
    const permanent=/permanent error|no such user|\b550\b|\b554\b|mail rejected/i.test(combined);
    return Object.freeze({type:delay?"delivery_delay":permanent?"permanent_bounce":"delivery_status",senderEmail,targetEmail:targets[0]??null,subject,body});
  }
  const auto=/auto[ -]?reply|automatic reply|out of office|away from (?:the )?office|we(?:'|’)ll get back to you shortly|one of our trip advisors will contact you soon/i.test(combined);
  return Object.freeze({type:auto?"auto_reply":"human_reply",senderEmail,targetEmail:null,subject,body});
}

function prospectRows(values) {
  if (!Array.isArray(values) || !Array.isArray(values[0])) throw new Error("pipeline values missing");
  return values.slice(1).map((row,index)=>({
    id:clean(row[0]), publisher:clean(row[3]), website:clean(row[4]), email:lower(row[13]),
    status:clean(row[16]), campaign:clean(row[26]), round2Status:clean(row[28]), sentDate:clean(row[29]),
    sheetRow:index+2,
  })).filter(x=>x.id);
}

export function mapInboundToProspect(event, values) {
  const rows=prospectRows(values);
  const target=lower(event?.targetEmail);
  const sender=lower(event?.senderEmail);
  if (target) {
    const exact=rows.filter(r=>r.email===target);
    if (exact.length===1) return Object.freeze({status:"mapped",matchBy:"target_email",prospect:exact[0]});
    if (exact.length>1) return Object.freeze({status:"ambiguous",matchBy:"target_email",matches:exact.map(x=>x.id)});
  }
  if (sender) {
    const exact=rows.filter(r=>r.email===sender);
    if (exact.length===1) return Object.freeze({status:"mapped",matchBy:"sender_email",prospect:exact[0]});
    if (exact.length>1) return Object.freeze({status:"ambiguous",matchBy:"sender_email",matches:exact.map(x=>x.id)});
    const domain=emailDomain(sender);
    if (domain) {
      const domainMatches=rows.filter(r=>emailDomain(r.email)===domain || websiteHost(r.website)===domain);
      if (domainMatches.length===1) return Object.freeze({status:"mapped",matchBy:"domain",prospect:domainMatches[0]});
      if (domainMatches.length>1) return Object.freeze({status:"ambiguous",matchBy:"domain",matches:domainMatches.map(x=>x.id)});
    }
  }
  return Object.freeze({status:"unmapped",matchBy:null,prospect:null});
}

export function analyzeInboundMessages(messages, values) {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  return messages.map(message=>{
    const event=classifyInboundMessage(message);
    const mapping=mapInboundToProspect(event,values);
    return Object.freeze({emailId:clean(message?.email_id),date:clean(message?.date),subject:event.subject,type:event.type,senderEmail:event.senderEmail,targetEmail:event.targetEmail,mapping});
  });
}
