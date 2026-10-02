function clean(value){return String(value??"").trim();}

export function planReplyActions(events){
  if(!Array.isArray(events)) throw new Error("events must be an array");
  return events.map(event=>{
    const emailId=clean(event?.emailId);
    const type=clean(event?.type);
    const mapping=event?.mapping;
    if(!emailId) throw new Error("emailId missing");
    if(!mapping||mapping.status!=="mapped"||!mapping.prospect){
      if(type==="human_reply") return Object.freeze({emailId,type,action:"manual_mapping_required",reason:"UNMAPPED_OR_AMBIGUOUS",sheetWrite:null,markProcessed:false});
      return Object.freeze({emailId,type,action:"mark_only",reason:"UNMAPPED_OR_AMBIGUOUS",sheetWrite:null,markProcessed:true});
    }
    const p=mapping.prospect;
    if(type==="human_reply"){
      const date=clean(event?.date).slice(0,10) || "unknown date";
      const subject=clean(event?.subject).replace(/\s+/g," ").slice(0,180);
      return Object.freeze({
        emailId,type,action:"queue_review",prospectId:p.id,sheetRow:p.sheetRow,
        sheetWrite:Object.freeze({
          replySummary:`Inbound reply received ${date}${subject?`: ${subject}`:""}`,
          nextAction:"Review inbound reply and respond",
        }),
      });
    }
    if(type==="permanent_bounce"){
      const alreadySuppressed=["Invalid Email","Delivery Failed"].includes(clean(p.status));
      return Object.freeze({
        emailId,type,action:alreadySuppressed?"mark_only":"suppress_delivery",prospectId:p.id,sheetRow:p.sheetRow,
        sheetWrite:alreadySuppressed?null:Object.freeze({status:"Delivery Failed",nextAction:"Find replacement contact email"}),
      });
    }
    if(type==="auto_reply") return Object.freeze({emailId,type,action:"mark_only",prospectId:p.id,sheetRow:p.sheetRow,sheetWrite:null});
    if(type==="delivery_delay") return Object.freeze({emailId,type,action:"mark_only",prospectId:p.id,sheetRow:p.sheetRow,sheetWrite:null});
    return Object.freeze({emailId,type,action:"mark_only",prospectId:p.id,sheetRow:p.sheetRow,sheetWrite:null});
  });
}
