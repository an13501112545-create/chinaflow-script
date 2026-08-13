(function () {

  const CONFIG = {
    publisher: "flightflex",

    rules: [

      // =====================================================
      // TEST 1 — FlightFlex Flights Page
      // =====================================================
      {
        path: "/flights",

        product: "flight",

        placement: "flightflex_flights_yyz_bjs_test",

        eyebrow: "FLIGHTFLEX RECOMMENDS",

        title: "Compare Toronto → Beijing Flights",

        subtitle: "Check fares and flight options on Trip.com",

        icon: "✈",

        url:
          "https://www.trip.com/flights/Toronto-to-Beijing/tickets-YTO-BJS?flighttype=S&dcity=YTO&acity=BJS&Allianceid=10021103&SID=328317298&trip_sub1=flightflex_flights_yyz_bjs_test&trip_sub3=D19214085"
      },


      // =====================================================
      // TEST 2 — China Inbound Tourism Blog
      // =====================================================
      {
        path:
          "/post/china-inbound-tourism-growth-trend-2026-why-more-travelers-are-returning-to-china",

        product: "hotel",

        placement:
          "flightflex_blog_china_inbound_hotels_test",

        eyebrow: "PLAN YOUR CHINA TRIP",

        title: "Find Hotels in Beijing",

        subtitle:
          "Compare hotel options and book your stay on Trip.com",

        icon: "▣",

        url:
          "https://www.trip.com/hotels/list?city=1&display=Beijing&optionId=1&optionType=City&optionName=Beijing&Allianceid=10021103&SID=328317298&trip_sub1=flightflex_blog_china_inbound_hotels_test&trip_sub3=D19216528"
      }

    ]
  };


  // =========================================================
  // Find monetization rule for current page
  // =========================================================

  function getCurrentRule() {

    const path = window.location.pathname.replace(/\/$/, "");

    return CONFIG.rules.find(function (rule) {

      return path === rule.path.replace(/\/$/, "");

    });

  }


  // =========================================================
  // Remove existing CTA
  // =========================================================

  function removeExistingCTA() {

    const existing =
      document.getElementById("chinaflow-auto-cta");

    if (existing) {
      existing.remove();
    }

  }


  // =========================================================
  // Render ChinaFlow CTA
  // =========================================================

  function runChinaFlow() {

    const rule = getCurrentRule();

    if (!rule) {
      removeExistingCTA();
      return;
    }

    if (
      document.getElementById("chinaflow-auto-cta")
    ) {
      return;
    }


    // ---------------------------------------------------------
    // Outer container
    // ---------------------------------------------------------

    const wrap = document.createElement("div");

    wrap.id = "chinaflow-auto-cta";

    wrap.dataset.publisher = CONFIG.publisher;
    wrap.dataset.product = rule.product;
    wrap.dataset.placement = rule.placement;


    Object.assign(wrap.style, {

      position: "fixed",

      left: "0",

      right: "0",

      bottom: "26px",

      zIndex: "999999",

      display: "flex",

      justifyContent: "center",

      padding: "0 18px",

      boxSizing: "border-box",

      pointerEvents: "none"

    });


    // ---------------------------------------------------------
    // Main CTA
    // ---------------------------------------------------------

    const link = document.createElement("a");

    link.href = rule.url;

    link.target = "_blank";

    link.rel = "noopener sponsored";

    link.setAttribute(
      "aria-label",
      rule.title
    );


    Object.assign(link.style, {

      width: "100%",

      maxWidth: "620px",

      minHeight: "82px",

      display: "flex",

      alignItems: "center",

      padding: "14px 18px",

      background:
        "linear-gradient(135deg, #0f3fbb 0%, #175de4 55%, #3478f6 100%)",

      color: "#ffffff",

      textDecoration: "none",

      borderRadius: "18px",

      boxShadow:
        "0 16px 40px rgba(20, 76, 190, 0.32)",

      border:
        "1px solid rgba(255,255,255,0.22)",

      boxSizing: "border-box",

      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',

      pointerEvents: "auto",

      transition:
        "transform 0.18s ease, box-shadow 0.18s ease",

      cursor: "pointer"

    });


    // ---------------------------------------------------------
    // Product icon
    // ---------------------------------------------------------

    const icon = document.createElement("div");

    icon.textContent = rule.icon;


    Object.assign(icon.style, {

      width: "48px",

      height: "48px",

      minWidth: "48px",

      display: "flex",

      alignItems: "center",

      justifyContent: "center",

      marginRight: "14px",

      borderRadius: "14px",

      background:
        "rgba(255,255,255,0.16)",

      fontSize: "23px",

      fontWeight: "700"

    });


    // ---------------------------------------------------------
    // Text area
    // ---------------------------------------------------------

    const content =
      document.createElement("div");


    Object.assign(content.style, {

      flex: "1",

      minWidth: "0"

    });


    // Eyebrow

    const eyebrow =
      document.createElement("div");

    eyebrow.textContent = rule.eyebrow;


    Object.assign(eyebrow.style, {

      marginBottom: "3px",

      fontSize: "10px",

      lineHeight: "1.2",

      fontWeight: "700",

      letterSpacing: "1.1px",

      color:
        "rgba(255,255,255,0.72)"

    });


    // Title

    const title =
      document.createElement("div");

    title.textContent = rule.title;


    Object.assign(title.style, {

      fontSize: "17px",

      lineHeight: "1.35",

      fontWeight: "700",

      color: "#ffffff"

    });


    // Subtitle

    const subtitle =
      document.createElement("div");

    subtitle.textContent = rule.subtitle;


    Object.assign(subtitle.style, {

      marginTop: "3px",

      fontSize: "12px",

      lineHeight: "1.3",

      fontWeight: "400",

      color:
        "rgba(255,255,255,0.78)"

    });


    // ---------------------------------------------------------
    // Arrow
    // ---------------------------------------------------------

    const arrow =
      document.createElement("div");

    arrow.textContent = "→";


    Object.assign(arrow.style, {

      width: "38px",

      minWidth: "38px",

      marginLeft: "12px",

      textAlign: "center",

      fontSize: "24px",

      fontWeight: "400",

      color: "#ffffff"

    });


    // ---------------------------------------------------------
    // Assemble CTA
    // ---------------------------------------------------------

    content.appendChild(eyebrow);

    content.appendChild(title);

    content.appendChild(subtitle);


    link.appendChild(icon);

    link.appendChild(content);

    link.appendChild(arrow);


    wrap.appendChild(link);


    document.body.appendChild(wrap);


    // ---------------------------------------------------------
    // Hover animation
    // ---------------------------------------------------------

    link.addEventListener(
      "mouseenter",
      function () {

        link.style.transform =
          "translateY(-3px)";

        link.style.boxShadow =
          "0 20px 46px rgba(20, 76, 190, 0.40)";

      }
    );


    link.addEventListener(
      "mouseleave",
      function () {

        link.style.transform =
          "translateY(0)";

        link.style.boxShadow =
          "0 16px 40px rgba(20, 76, 190, 0.32)";

      }
    );


    // ---------------------------------------------------------
    // Mobile styling
    // ---------------------------------------------------------

    if (window.innerWidth <= 600) {

      wrap.style.bottom = "14px";

      wrap.style.padding = "0 10px";


      link.style.minHeight = "72px";

      link.style.padding = "11px 13px";

      link.style.borderRadius = "15px";


      icon.style.width = "42px";

      icon.style.height = "42px";

      icon.style.minWidth = "42px";

      icon.style.marginRight = "11px";


      title.style.fontSize = "15px";

      subtitle.style.fontSize = "11px";


      arrow.style.width = "25px";

      arrow.style.minWidth = "25px";

      arrow.style.marginLeft = "7px";

      arrow.style.fontSize = "20px";

    }

  }


  // =========================================================
  // Initial load
  // =========================================================

  function initializeChinaFlow() {

    setTimeout(
      runChinaFlow,
      400
    );

  }


  if (
    document.readyState === "loading"
  ) {

    document.addEventListener(
      "DOMContentLoaded",
      initializeChinaFlow
    );

  } else {

    initializeChinaFlow();

  }


  // =========================================================
  // Wix SPA navigation detection
  // =========================================================

  let lastUrl =
    window.location.href;


  new MutationObserver(
    function () {

      if (
        window.location.href !== lastUrl
      ) {

        lastUrl =
          window.location.href;

        removeExistingCTA();

        setTimeout(
          runChinaFlow,
          400
        );

      }

    }
  ).observe(
    document.documentElement,
    {

      childList: true,

      subtree: true

    }
  );


})();
