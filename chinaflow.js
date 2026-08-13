(function () {
  const CONFIG = {
    publisher: "flightflex",
    rules: [{
      path: "/flights",
      placement: "flightflex_flights_yyz_bjs_test",
      label: "Compare Toronto → Beijing Flights on Trip.com →",
      url: "https://www.trip.com/flights/Toronto-to-Beijing/tickets-YTO-BJS?flighttype=S&dcity=YTO&acity=BJS&Allianceid=10021103&SID=328317298&trip_sub1=flightflex_flights_yyz_bjs_test&trip_sub3=D19214085"
    }]
  };

  function runChinaFlow() {
    const rule = CONFIG.rules.find(r => window.location.pathname === r.path);
    if (!rule) return;
    if (document.getElementById("chinaflow-auto-cta")) return;

    const wrap = document.createElement("div");
    wrap.id = "chinaflow-auto-cta";

    Object.assign(wrap.style, {
      position: "fixed",
      left: "20px",
      right: "20px",
      bottom: "20px",
      zIndex: "999999"
    });

    const link = document.createElement("a");
    link.href = rule.url;
    link.target = "_blank";
    link.rel = "noopener sponsored";
    link.textContent = rule.label;

    Object.assign(link.style, {
      display: "block",
      maxWidth: "720px",
      margin: "0 auto",
      padding: "16px 22px",
      background: "#ffffff",
      border: "2px solid #3164f4",
      color: "#1454e8",
      textDecoration: "none",
      textAlign: "center",
      fontFamily: "Arial, sans-serif",
      fontSize: "17px",
      fontWeight: "600",
      borderRadius: "6px",
      boxShadow: "0 6px 20px rgba(0,0,0,.10)"
    });

    wrap.appendChild(link);
    document.body.appendChild(wrap);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runChinaFlow);
  } else {
    runChinaFlow();
  }

  let lastUrl = window.location.href;

  new MutationObserver(function () {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;

      const old = document.getElementById("chinaflow-auto-cta");
      if (old) old.remove();

      setTimeout(runChinaFlow, 300);
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
