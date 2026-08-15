(function () {

  const CHINAFLOW_CONFIG_URL =
    "https://raw.githubusercontent.com/an13501112545-create/chinaflow-script/main/config.json";

  const ENGINE_VERSION =
    "0.4";

  const SESSION_STORAGE_KEY =
    "chinaflow_event_session_v1";

  let CONFIG = null;
  let memorySessionId = null;
  let activeAnalyticsCleanup = null;
  let evaluationGeneration = 0;


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
        "[ChinaFlow v0.4] Config load failed",
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


  function nullableValue(value) {

    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      return null;
    }

    return value;

  }


  function readAnalyticsConfig() {

    try {

      const analytics =
        CONFIG?.analytics;

      if (
        !analytics ||
        typeof analytics !== "object"
      ) {
        return {
          enabled: false,
          event_schema_version: null,
          collector_url: null
        };
      }

      const eventSchemaVersion =
        nullableValue(
          analytics.event_schema_version
        );

      const collectorUrl =
        nullableValue(
          analytics.collector_url
        );

      return {

        enabled:
          analytics.enabled === true &&
          typeof eventSchemaVersion ===
            "string" &&
          eventSchemaVersion.trim() !== "" &&
          typeof collectorUrl ===
            "string" &&
          collectorUrl.trim() !== "",

        event_schema_version:
          eventSchemaVersion,

        collector_url:
          collectorUrl

      };

    } catch (error) {

      return {
        enabled: false,
        event_schema_version: null,
        collector_url: null
      };

    }

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
  // NORMALIZED ROUTING
  // =========================================================

  function createRoute(
    source,
    analytics
  ) {

    return {

      product:
        source.product,

      placement:
        source.placement,

      eyebrow:
        source.eyebrow,

      title:
        source.title,

      subtitle:
        source.subtitle,

      icon:
        source.icon,

      url:
        source.url,

      routing_mode:
        analytics.routing_mode,

      rule_id:
        analytics.rule_id,

      offer_id:
        analytics.offer_id,

      routing_reason:
        analytics.routing_reason,

      china_intent:
        analytics.china_intent,

      china_intent_score:
        analytics.china_intent_score,

      product_intent:
        analytics.product_intent,

      product_score:
        analytics.product_score

    };

  }


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
        "[ChinaFlow v0.4] Exact rule:",
        exactRule.id
      );

      return createRoute(
        exactRule,
        {
          routing_mode:
            "exact_rule",
          rule_id:
            nullableValue(
              exactRule.rule_id
            ) ||
            nullableValue(exactRule.id),
          offer_id:
            nullableValue(exactRule.offer_id),
          routing_reason:
            null,
          china_intent:
            null,
          china_intent_score:
            null,
          product_intent:
            null,
          product_score:
            null
        }
      );

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
        "[ChinaFlow v0.4] Non-content page — no auto routing"
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
      "[ChinaFlow v0.4] China travel analysis:",
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
        "[ChinaFlow v0.4] No China travel intent"
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
      "[ChinaFlow v0.4] Product intent:",
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
        "[ChinaFlow v0.4] No offer available:",
        productIntent.product
      );

      return null;

    }


    console.log(
      "[ChinaFlow v0.4] Smart route:",
      productIntent.product,
      "→",
      offer.id
    );


    return createRoute(
      offer,
      {
        routing_mode:
          "auto",
        rule_id:
          "auto-" +
          productIntent.product +
          "-offer",
        offer_id:
          nullableValue(
            offer.offer_id
          ) ||
          nullableValue(offer.id),
        routing_reason:
          productIntent.reason,
        china_intent:
          travelIntent.matched,
        china_intent_score:
          travelIntent.score,
        product_intent:
          productIntent.product,
        product_score:
          productIntent.scores[
            productIntent.product
          ]
      }
    );

  }


  // =========================================================
  // EVENT DATA
  // =========================================================

  function createUUID() {

    try {

      if (
        !window.crypto ||
        typeof window.crypto.randomUUID !==
          "function"
      ) {
        return null;
      }

      return window.crypto.randomUUID();

    } catch (error) {

      return null;

    }

  }


  function getSessionId() {

    try {

      const storedSessionId =
        window.sessionStorage.getItem(
          SESSION_STORAGE_KEY
        );

      if (storedSessionId) {
        memorySessionId =
          storedSessionId;
        return storedSessionId;
      }

      const newSessionId =
        createUUID();

      if (!newSessionId) {
        return null;
      }

      window.sessionStorage.setItem(
        SESSION_STORAGE_KEY,
        newSessionId
      );

      memorySessionId =
        newSessionId;

      return newSessionId;

    } catch (error) {

      if (memorySessionId) {
        return memorySessionId;
      }

      memorySessionId =
        createUUID();

      return memorySessionId;

    }

  }


  function parseTripSub1(
    destinationUrl
  ) {

    try {

      const url =
        new URL(
          destinationUrl,
          window.location.href
        );

      return nullableValue(
        url.searchParams.get(
          "trip_sub1"
        )
      );

    } catch (error) {

      return null;

    }

  }


  function readReferrerOrigin() {

    try {

      if (!document.referrer) {
        return "";
      }

      return new URL(
        document.referrer
      ).origin;

    } catch (error) {

      return "";

    }

  }


  function buildEventPayload(
    eventType,
    route
  ) {

    try {

      const eventId =
        createUUID();

      if (!eventId) {
        return null;
      }

      const sessionId =
        getSessionId();

      if (!sessionId) {
        return null;
      }

      const analyticsConfig =
        readAnalyticsConfig();

      return {

        event_schema_version:
          analyticsConfig
            .event_schema_version,

        event_id:
          eventId,

        event_type:
          eventType,

        timestamp:
          new Date().toISOString(),

        publisher_id:
          nullableValue(
            CONFIG?.publisher
          ),

        session_id:
          sessionId,

        page_url:
          window.location.origin +
          window.location.pathname,

        page_path:
          window.location.pathname,

        page_title:
          document.title || "",

        referrer:
          readReferrerOrigin(),

        routing_mode:
          route.routing_mode,

        china_intent:
          route.china_intent,

        china_intent_score:
          route.china_intent_score,

        product_intent:
          route.product_intent,

        product_score:
          route.product_score,

        routing_reason:
          route.routing_reason,

        rule_id:
          route.rule_id,

        offer_id:
          route.offer_id,

        placement:
          nullableValue(route.placement),

        trip_sub1:
          parseTripSub1(route.url),

        supplier:
          "trip.com",

        destination_url:
          route.url,

        engine_version:
          ENGINE_VERSION,

        config_version:
          nullableValue(
            CONFIG?.version
          ),

        viewport_width:
          window.innerWidth,

        viewport_height:
          window.innerHeight

      };

    } catch (error) {

      return null;

    }

  }


  // =========================================================
  // ANALYTICS TRANSPORT
  // =========================================================

  function transportEvent(
    payload
  ) {

    try {

      const analyticsConfig =
        readAnalyticsConfig();

      if (
        analyticsConfig.enabled !== true
      ) {
        return;
      }

      if (
        typeof analyticsConfig.collector_url !==
          "string" ||
        analyticsConfig.collector_url.trim() === ""
      ) {
        return;
      }

      if (
        typeof navigator === "undefined" ||
        typeof navigator.sendBeacon !== "function"
      ) {
        return;
      }

      const blob = new Blob(
        [JSON.stringify(payload)],
        {
          type:
            "text/plain;charset=UTF-8"
        }
      );

      navigator.sendBeacon(
        analyticsConfig.collector_url,
        blob
      );

    } catch (error) {

      // Analytics is always fail-open.

    }

  }


  function trackEvent(
    eventType,
    route
  ) {

    try {

      const analyticsConfig =
        readAnalyticsConfig();

      if (
        analyticsConfig.enabled !== true
      ) {
        return;
      }

      const payload =
        buildEventPayload(
          eventType,
          route
        );

      if (!payload) {
        return;
      }

      transportEvent(payload);

    } catch (error) {

      // Analytics is always fail-open.

    }

  }


  // =========================================================
  // ANALYTICS LIFECYCLE
  // =========================================================

  function cleanupActiveAnalytics() {

    const cleanup =
      activeAnalyticsCleanup;

    activeAnalyticsCleanup =
      null;

    if (!cleanup) {
      return;
    }

    try {
      cleanup();
    } catch (error) {
      // Analytics cleanup must not affect routing or rendering.
    }

  }


  function installCTAAnalytics(
    wrap,
    link,
    route
  ) {

    let active = true;
    let impressionSent = false;
    let observer = null;


    function emitImpressionOnce() {

      if (
        !active ||
        impressionSent
      ) {
        return;
      }

      impressionSent = true;

      if (observer) {
        try {
          observer.disconnect();
        } catch (error) {
          // The one-impression guard remains authoritative.
        }
      }

      trackEvent(
        "cta_impression",
        route
      );

    }


    function handleClick() {

      /*
       * Never prevent, await, replace, or recreate navigation.
       * The normal anchor remains the revenue path.
       */
      trackEvent(
        "cta_click",
        route
      );

    }


    try {
      link.addEventListener(
        "click",
        handleClick
      );
    } catch (error) {
      // Click tracking is optional; navigation is untouched.
    }


    try {

      if (
        typeof window.IntersectionObserver ===
          "function"
      ) {

        observer =
          new window.IntersectionObserver(
            function (entries) {

              if (!active) {
                return;
              }

              const isVisible =
                entries.some(
                  function (entry) {
                    return (
                      entry.target === wrap &&
                      entry.isIntersecting &&
                      entry.intersectionRatio > 0
                    );
                  }
                );

              if (isVisible) {
                emitImpressionOnce();
              }

            },
            {
              threshold:
                0
            }
          );

        observer.observe(wrap);

      } else {

        emitImpressionOnce();

      }

    } catch (error) {

      /*
       * If observer construction or observation is unavailable,
       * a successful render is the conservative fallback.
       */
      emitImpressionOnce();

    }


    return function () {

      active = false;

      if (observer) {
        try {
          observer.disconnect();
        } catch (error) {
          // Best-effort analytics cleanup.
        }
      }

      try {
        link.removeEventListener(
          "click",
          handleClick
        );
      } catch (error) {
        // Best-effort analytics cleanup.
      }

    };

  }


  // =========================================================
  // REMOVE CTA
  // =========================================================

  function removeExistingCTA() {

    cleanupActiveAnalytics();

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

  function renderCTA(route) {

    if (!route) {
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
      route.product || "";

    wrap.dataset.placement =
      route.placement || "";

    wrap.dataset.rule =
      route.rule_id || "";


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
      route.url;

    link.target =
      "_blank";

    link.rel =
      "noopener sponsored";


    link.setAttribute(
      "aria-label",
      route.title ||
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
      route.icon || "→";


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
      route.eyebrow || "";


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
      route.title || "";


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
      route.subtitle || "";


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


    try {

      activeAnalyticsCleanup =
        installCTAAnalytics(
          wrap,
          link,
          route
        );

    } catch (error) {

      activeAnalyticsCleanup =
        null;

    }

  }


  // =========================================================
  // EVALUATE
  // =========================================================

  async function evaluatePage(
    generation
  ) {

    if (
      generation !==
      evaluationGeneration
    ) {
      return;
    }

    removeExistingCTA();

    await loadConfig();

    if (
      generation !==
        evaluationGeneration ||
      !CONFIG
    ) {
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


    if (
      generation !==
      evaluationGeneration
    ) {
      return;
    }


    const route =
      selectRule();


    if (route) {

      renderCTA(
        route
      );

    }

  }


  // =========================================================
  // START
  // =========================================================

  function scheduleEvaluation() {

    const generation =
      ++evaluationGeneration;

    setTimeout(
      function () {
        evaluatePage(generation);
      },
      700
    );

  }


  function initialize() {

    scheduleEvaluation();

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

        /*
         * Invalidate delayed work immediately. The existing CTA
         * remains until the normal v0.3 evaluation delay elapses,
         * but its analytics stops with the old page context.
         */
        cleanupActiveAnalytics();

        scheduleEvaluation();

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
