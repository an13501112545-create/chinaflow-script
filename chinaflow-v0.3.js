(function () {

  const CHINAFLOW_CONFIG_URL =
    "https://raw.githubusercontent.com/an13501112545-create/chinaflow-script/main/config.json";

  let CONFIG = null;


  // =========================================================
  // CONFIG
  // =========================================================

  async function loadConfig() {

    try {

      const response = await fetch(
        CHINAFLOW_CONFIG_URL + "?t=" + Date.now(),
        {
          cache: "no-store"
        }
      );

      if (!response.ok) {
        throw new Error(
          "Config load failed: " + response.status
        );
      }

      CONFIG = await response.json();

      return CONFIG;

    } catch (error) {

      console.error(
        "[ChinaFlow v0.3] Config load failed",
        error
      );

      return null;

    }

  }


  // =========================================================
  // HELPERS
  // =========================================================

  function normalizePath(path) {

    if (!path) return "/";

    if (
      path.length > 1 &&
      path.endsWith("/")
    ) {
      return path.slice(0, -1);
    }

    return path;

  }


  function normalizeText(text) {

    return String(text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

  }


  function countKeyword(text, keyword) {

    if (!text || !keyword) {
      return 0;
    }

    let count = 0;
    let position = 0;

    while (true) {

      position =
        text.indexOf(
          keyword,
          position
        );

      if (position === -1) {
        break;
      }

      count++;

      position +=
        keyword.length;

    }

    return count;

  }


  // =========================================================
  // READ PAGE
  // =========================================================

  function readPageContext() {

    const rawTitle =
      document.querySelector("h1")?.innerText ||
      document.title ||
      "";

    const rawMeta =
      document
        .querySelector(
          'meta[name="description"]'
        )
        ?.getAttribute("content") ||
      "";

    /*
     * Use paragraph content instead of entire body.
     * This prevents site navigation / brand name such as
     * "FlightFlex" from polluting product classification.
     */
    const paragraphs =
      Array.from(
        document.querySelectorAll("p")
      )
      .map(
        element =>
          element.innerText || ""
      )
      .join(" ");

    const title =
      normalizeText(rawTitle);

    const meta =
      normalizeText(rawMeta);

    const body =
      normalizeText(
        paragraphs.slice(0, 15000)
      );

    return {

      path:
        normalizePath(
          window.location.pathname
        ),

      title:
        title,

      meta:
        meta,

      body:
        body,

      strongText:
        normalizeText(
          title + " " + meta
        ),

      allText:
        normalizeText(
          title +
          " " +
          meta +
          " " +
          body
        )

    };

  }


  // =========================================================
  // EXACT URL RULE
  // =========================================================

  function findExactPathRule(
    context
  ) {

    if (
      !CONFIG ||
      !Array.isArray(CONFIG.rules)
    ) {
      return null;
    }


    return CONFIG.rules.find(
      function (rule) {

        if (
          rule.enabled === false ||
          !rule.match
        ) {
          return false;
        }

        if (
          rule.match.type !== "path"
        ) {
          return false;
        }

        return (
          context.path ===
          normalizePath(
            rule.match.value
          )
        );

      }
    );

  }


  // =========================================================
  // CHINA TRAVEL INTENT
  // =========================================================

  function detectChinaTravelIntent(
    context
  ) {

    const chinaSignals = [

      "china",
      "travel to china",
      "trip to china",
      "visit china",
      "china travel",
      "china tourism",
      "china inbound",

      "beijing",
      "shanghai",
      "guangzhou",
      "shenzhen",
      "chengdu",
      "xi'an",
      "xian",
      "hangzhou",
      "suzhou",
      "guilin",
      "zhangjiajie"

    ];


    const travelSignals = [

      "travel",
      "trip",
      "tourism",
      "tourist",
      "visitor",
      "visit",
      "vacation",
      "holiday",
      "itinerary",

      "hotel",
      "flight",
      "airport",
      "train",
      "attraction",
      "tour"

    ];


    const chinaMatches =
      chinaSignals.filter(
        keyword =>
          context.allText.includes(
            keyword
          )
      );


    const travelMatches =
      travelSignals.filter(
        keyword =>
          context.allText.includes(
            keyword
          )
      );


    const score =
      chinaMatches.length * 2 +
      travelMatches.length;


    return {

      matched:
        chinaMatches.length >= 1 &&
        travelMatches.length >= 1 &&
        score >= 4,

      score:
        score,

      chinaMatches:
        chinaMatches,

      travelMatches:
        travelMatches

    };

  }


  // =========================================================
  // PRODUCT INTENT
  // =========================================================

  function calculateProductScore(
    context,
    keywords
  ) {

    let score = 0;

    keywords.forEach(
      function (keyword) {

        /*
         * H1 + meta are high-intent signals.
         *
         * Example:
         * "Best Flight Options Between Canada and China"
         *
         * should strongly route to Flight.
         */
        const strongCount =
          countKeyword(
            context.strongText,
            keyword
          );

        /*
         * Body text is weaker.
         */
        const bodyCount =
          countKeyword(
            context.body,
            keyword
          );


        score +=
          strongCount * 6;

        score +=
          Math.min(
            bodyCount,
            3
          );

      }
    );

    return score;

  }


  function detectProductIntent(
    context
  ) {

    const flightKeywords = [

      "flight",
      "flights",
      "airfare",
      "airline",
      "airlines",
      "flying",
      "plane ticket",
      "plane tickets",
      "air ticket",
      "air tickets"

    ];


    const hotelKeywords = [

      "hotel",
      "hotels",
      "accommodation",
      "accommodations",
      "where to stay",
      "place to stay",
      "places to stay",
      "resort",
      "resorts"

    ];


    const flightScore =
      calculateProductScore(
        context,
        flightKeywords
      );


    const hotelScore =
      calculateProductScore(
        context,
        hotelKeywords
      );


    let product =
      "hotel";

    let reason =
      "generic_china_travel_fallback";


    /*
     * Specialized product routing requires
     * a strong signal.
     *
     * We intentionally do NOT send a generic
     * China article to Flights just because
     * the article briefly mentions flights.
     */
    if (
      flightScore >= 6 &&
      flightScore >
        hotelScore + 2
    ) {

      product =
        "flight";

      reason =
        "strong_flight_intent";

    } else if (
      hotelScore >= 6 &&
      hotelScore >
        flightScore + 2
    ) {

      product =
        "hotel";

      reason =
        "strong_hotel_intent";

    }


    return {

      product:
        product,

      reason:
        reason,

      scores: {

        flight:
          flightScore,

        hotel:
          hotelScore

      }

    };

  }


  // =========================================================
  // OFFER LOOKUP
  // =========================================================

  function findOffer(
    product
  ) {

    if (
      !CONFIG ||
      !Array.isArray(
        CONFIG.offers
      )
    ) {
      return null;
    }


    return CONFIG.offers.find(
      function (offer) {

        return (
          offer.enabled !== false &&
          offer.product === product
        );

      }
    );

  }


  // =========================================================
  // SMART ROUTING
  // =========================================================

  function selectRule() {

    const context =
      readPageContext();


    /*
     * Priority 1
     *
     * Publisher explicitly configured
     * a specific URL.
     */
    const exactRule =
      findExactPathRule(
        context
      );


    if (exactRule) {

      console.log(
        "[ChinaFlow v0.3] Exact rule:",
        exactRule.id
      );

      return exactRule;

    }


    /*
     * Priority 2
     *
     * Automatic monetization applies
     * to content pages.
     */
    if (
      !context.path.startsWith(
        "/post/"
      )
    ) {

      console.log(
        "[ChinaFlow v0.3] Non-content page — no auto routing"
      );

      return null;

    }


    /*
     * Step A
     *
     * Is this China travel content?
     */
    const travelIntent =
      detectChinaTravelIntent(
        context
      );


    console.log(
      "[ChinaFlow v0.3] China travel analysis:",
      {

        title:
          context.title,

        score:
          travelIntent.score,

        china:
          travelIntent.chinaMatches,

        travel:
          travelIntent.travelMatches

      }
    );


    if (
      !travelIntent.matched
    ) {

      console.log(
        "[ChinaFlow v0.3] No China travel intent"
      );

      return null;

    }


    /*
     * Step B
     *
     * Which travel product?
     */
    const productIntent =
      detectProductIntent(
        context
      );


    console.log(
      "[ChinaFlow v0.3] Product intent:",
      productIntent
    );


    /*
     * Step C
     *
     * Find corresponding affiliate offer.
     */
    const offer =
      findOffer(
        productIntent.product
      );


    if (!offer) {

      console.warn(
        "[ChinaFlow v0.3] No offer available:",
        productIntent.product
      );

      return null;

    }


    console.log(
      "[ChinaFlow v0.3] Smart route:",
      productIntent.product,
      "→",
      offer.id
    );


    return {

      ...offer,

      id:
        "auto-" +
        productIntent.product +
        "-offer",

      routing_reason:
        productIntent.reason

    };

  }


  // =========================================================
  // REMOVE CTA
  // =========================================================

  function removeExistingCTA() {

    const existing =
      document.getElementById(
        "chinaflow-auto-cta"
      );

    if (existing) {
      existing.remove();
    }

  }


  // =========================================================
  // RENDER CTA
  // =========================================================

  function renderCTA(rule) {

    if (!rule) {
      return;
    }


    const wrap =
      document.createElement(
        "div"
      );

    wrap.id =
      "chinaflow-auto-cta";


    wrap.dataset.publisher =
      CONFIG?.publisher || "";

    wrap.dataset.product =
      rule.product || "";

    wrap.dataset.placement =
      rule.placement || "";

    wrap.dataset.rule =
      rule.id || "";


    Object.assign(
      wrap.style,
      {

        position:
          "fixed",

        left:
          "0",

        right:
          "0",

        bottom:
          "26px",

        zIndex:
          "999999",

        display:
          "flex",

        justifyContent:
          "center",

        padding:
          "0 18px",

        boxSizing:
          "border-box",

        pointerEvents:
          "none"

      }
    );


    const link =
      document.createElement(
        "a"
      );


    link.href =
      rule.url;

    link.target =
      "_blank";

    link.rel =
      "noopener sponsored";


    link.setAttribute(
      "aria-label",
      rule.title ||
        "Travel offer"
    );


    Object.assign(
      link.style,
      {

        width:
          "100%",

        maxWidth:
          "620px",

        minHeight:
          "82px",

        display:
          "flex",

        alignItems:
          "center",

        padding:
          "14px 18px",

        background:
          "linear-gradient(135deg, #0f3fbb 0%, #175de4 55%, #3478f6 100%)",

        color:
          "#ffffff",

        textDecoration:
          "none",

        borderRadius:
          "18px",

        boxShadow:
          "0 16px 40px rgba(20, 76, 190, 0.32)",

        border:
          "1px solid rgba(255,255,255,0.22)",

        boxSizing:
          "border-box",

        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',

        pointerEvents:
          "auto",

        cursor:
          "pointer",

        transition:
          "transform 0.18s ease, box-shadow 0.18s ease"

      }
    );


    const icon =
      document.createElement(
        "div"
      );


    icon.textContent =
      rule.icon || "→";


    Object.assign(
      icon.style,
      {

        width:
          "48px",

        height:
          "48px",

        minWidth:
          "48px",

        display:
          "flex",

        alignItems:
          "center",

        justifyContent:
          "center",

        marginRight:
          "14px",

        borderRadius:
          "14px",

        background:
          "rgba(255,255,255,0.16)",

        fontSize:
          "23px",

        fontWeight:
          "700"

      }
    );


    const content =
      document.createElement(
        "div"
      );


    Object.assign(
      content.style,
      {

        flex:
          "1",

        minWidth:
          "0"

      }
    );


    const eyebrow =
      document.createElement(
        "div"
      );


    eyebrow.textContent =
      rule.eyebrow || "";


    Object.assign(
      eyebrow.style,
      {

        marginBottom:
          "3px",

        fontSize:
          "10px",

        lineHeight:
          "1.2",

        fontWeight:
          "700",

        letterSpacing:
          "1.1px",

        color:
          "rgba(255,255,255,0.72)"

      }
    );


    const title =
      document.createElement(
        "div"
      );


    title.textContent =
      rule.title || "";


    Object.assign(
      title.style,
      {

        fontSize:
          "17px",

        lineHeight:
          "1.35",

        fontWeight:
          "700",

        color:
          "#ffffff"

      }
    );


    const subtitle =
      document.createElement(
        "div"
      );


    subtitle.textContent =
      rule.subtitle || "";


    Object.assign(
      subtitle.style,
      {

        marginTop:
          "3px",

        fontSize:
          "12px",

        lineHeight:
          "1.3",

        color:
          "rgba(255,255,255,0.78)"

      }
    );


    const arrow =
      document.createElement(
        "div"
      );


    arrow.textContent =
      "→";


    Object.assign(
      arrow.style,
      {

        width:
          "38px",

        minWidth:
          "38px",

        marginLeft:
          "12px",

        textAlign:
          "center",

        fontSize:
          "24px",

        color:
          "#ffffff"

      }
    );


    content.appendChild(
      eyebrow
    );

    content.appendChild(
      title
    );

    content.appendChild(
      subtitle
    );


    link.appendChild(
      icon
    );

    link.appendChild(
      content
    );

    link.appendChild(
      arrow
    );


    wrap.appendChild(
      link
    );


    document.body.appendChild(
      wrap
    );


    link.addEventListener(
      "mouseenter",
      function () {

        link.style.transform =
          "translateY(-3px)";

      }
    );


    link.addEventListener(
      "mouseleave",
      function () {

        link.style.transform =
          "translateY(0)";

      }
    );


    if (
      window.innerWidth <= 600
    ) {

      wrap.style.bottom =
        "14px";

      wrap.style.padding =
        "0 10px";


      link.style.minHeight =
        "72px";

      link.style.padding =
        "11px 13px";

      link.style.borderRadius =
        "15px";


      title.style.fontSize =
        "15px";

      subtitle.style.fontSize =
        "11px";

    }

  }


  // =========================================================
  // EVALUATE
  // =========================================================

  async function evaluatePage() {

    removeExistingCTA();

    await loadConfig();

    if (!CONFIG) {
      return;
    }


    /*
     * Allow Wix Blog to finish rendering.
     */
    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          1000
        )
    );


    const rule =
      selectRule();


    if (rule) {

      renderCTA(
        rule
      );

    }

  }


  // =========================================================
  // START
  // =========================================================

  function initialize() {

    setTimeout(
      evaluatePage,
      700
    );

  }


  if (
    document.readyState ===
    "loading"
  ) {

    document.addEventListener(
      "DOMContentLoaded",
      initialize
    );

  } else {

    initialize();

  }


  // =========================================================
  // WIX SPA NAVIGATION
  // =========================================================

  let lastUrl =
    window.location.href;


  new MutationObserver(
    function () {

      if (
        window.location.href !==
        lastUrl
      ) {

        lastUrl =
          window.location.href;

        setTimeout(
          evaluatePage,
          700
        );

      }

    }
  ).observe(
    document.documentElement,
    {

      childList:
        true,

      subtree:
        true

    }
  );


})();
