(function () {
  'use strict';
  const engineElement = document.currentScript;
  const registry = document.__chinaflowSelfServiceRuntime;
  const RELEASE = 'loader-0.3/engine-0.6';
  try {
    if (!registry || registry.state !== 'loading' || registry.release !== RELEASE ||
        engineElement !== registry.engineElement || !(engineElement instanceof HTMLScriptElement) ||
        !engineElement.isConnected ||
        !/^cfi_[0-9a-f]{32}$/.test(registry.installKey)) return;
    const origin = new URL(registry.runtimeOrigin);
    const expected = new URL('/v1/config', origin.origin);
    expected.searchParams.set('install_key', registry.installKey);
    if (origin.protocol !== 'https:' || origin.origin !== registry.runtimeOrigin ||
        registry.configUrl !== expected.href ||
        engineElement.src !== new URL('/runtime/chinaflow-v0.6.js', origin).href) return;
  } catch (_) { return; }

  const ENGINE_VERSION = '0.6';
  const SESSION_STORAGE_KEY = 'chinaflow_event_session_v1';
  let CONFIG = null;
  let memorySessionId = null;
  let activeAnalyticsCleanup = null;
  let ownedCTA = null;
  const ctaListeners = [];
  let pending = null;
  let renderTimer = null;
  let stopped = false;
  let lastUrl = window.location.href;

  function isCurrent(generation) {
    return !stopped && registry.state !== 'disabled' && registry.generation === generation &&
      window.location.href === lastUrl;
  }

  function usableDestination(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
        !['hotel', 'flight'].includes(source.product) ||
        typeof source.placement !== 'string' || !source.placement.trim() ||
        typeof source.url !== 'string' || /[\s\x00-\x1f\x7f\\]/u.test(source.url) ||
        !/^https:\/\//i.test(source.url)) return false;
    try {
      const url = new URL(source.url);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ['id', 'rule_id', 'offer_id', 'title', 'subtitle', 'eyebrow', 'icon'].every(key =>
          source[key] === undefined || source[key] === null || typeof source[key] === 'string') &&
        (source.enabled === undefined || typeof source.enabled === 'boolean');
    } catch (_) { return false; }
  }

  function validateConfig(value) {
    const page = new URL(window.location.href);
    const hostname = page.hostname.toLowerCase().replace(/\.$/, '');
    const labels = hostname.split('.');
    if (!value || value.version !== '0.2' || value.runtime_enabled !== true ||
        page.protocol !== 'https:' || page.port || labels.length < 2 ||
        hostname.length > 253 || /^[0-9.]+$/.test(hostname) ||
        labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        value.bound_origin !== `https://${hostname}` ||
        !Array.isArray(value.rules) || !Array.isArray(value.offers)) return null;
    // Invalid exact rules reject the config, so they cannot silently fall through
    // to automatic routing. Valid rule order and short-circuit behavior stay intact.
    if (!value.rules.every(rule => usableDestination(rule) && rule.match &&
        rule.match.type === 'path' && typeof rule.match.value === 'string' &&
        rule.match.value.startsWith('/'))) return null;
    const offers = value.offers.filter(usableDestination);
    if (!offers.some(offer => offer.enabled !== false)) return null;
    return { ...value, offers };
  }

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




    if (
      !travelIntent.matched
    ) {


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


      return null;

    }




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
    route,
    generation
  ) {

    if (!readAnalyticsConfig().enabled) return null;
    let active = true;
    let impressionSent = false;
    let observer = null;


    function emitImpressionOnce() {

      if (
        !active || !isCurrent(generation) ||
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
      if (!active || !isCurrent(generation)) return;

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

              if (!active || !isCurrent(generation)) {
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

    if (ownedCTA) ownedCTA.remove();
    ownedCTA = null;
    for (const remove of ctaListeners.splice(0)) remove();

  }


  // =========================================================
  // RENDER CTA
  // =========================================================

  function renderCTA(route, generation) {

    if (!route || !isCurrent(generation)) {
      return;
    }


    const wrap =
      document.createElement(
        "div"
      );

    wrap.id =
      "chinaflow-auto-cta";


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


    ownedCTA = wrap;
    document.body.appendChild(wrap);


    const enter = () => { if (isCurrent(generation)) link.style.transform = "translateY(-3px)"; };
    const leave = () => { if (isCurrent(generation)) link.style.transform = "translateY(0)"; };
    link.addEventListener("mouseenter", enter);
    link.addEventListener("mouseleave", leave);
    ctaListeners.push(() => link.removeEventListener("mouseenter", enter),
      () => link.removeEventListener("mouseleave", leave));

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
          route,
          generation
        );

    } catch (error) {

      activeAnalyticsCleanup =
        null;

    }

  }


  // Every refresh invalidates shared state before starting asynchronous work.
  function refresh() {
    if (stopped || registry.state === 'disabled') return;
    lastUrl = window.location.href;
    const generation = ++registry.generation;
    CONFIG = null;
    removeExistingCTA();
    clearTimeout(renderTimer);
    pending?.cancel();
    registry.state = 'loading';
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timeout;
    let cancel;
    const deadline = new Promise((_, reject) => {
      cancel = () => { clearTimeout(timeout); controller?.abort(); reject(new Error('Cancelled')); };
      timeout = setTimeout(cancel, 10000);
    });
    const request = { cancel };
    pending = request;
    // The deadline includes JSON body parsing, even if abort is unavailable/ignored.
    const work = Promise.resolve().then(async () => {
      if (!isCurrent(generation)) return null;
      const response = await fetch(registry.configUrl, {
        credentials: 'omit', mode: 'cors', cache: 'no-store', redirect: 'error',
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!response.ok || response.status < 200 || response.status >= 300 || response.redirected) return null;
      return validateConfig(await response.json());
    });
    Promise.race([work, deadline]).then(value => {
      if (!isCurrent(generation) || !value) return;
      CONFIG = value;
      registry.state = 'active';
      // Preserve the Wix content-settling delay; all delayed work is generation-bound.
      renderTimer = setTimeout(() => {
        if (!isCurrent(generation) || !CONFIG || !document.body) return;
        const route = selectRule();
        if (route) renderCTA(route, generation);
      }, 1000);
    }).catch(() => {
      // The current request already cleared CONFIG. Stale failures mutate nothing.
    }).finally(() => {
      clearTimeout(timeout);
      if (pending === request) pending = null;
    });
  }

  const historyRestorers = [];
  function navigation() {
    if (window.location.href !== lastUrl) refresh();
  }
  function shutdown() {
    if (stopped) return;
    stopped = true;
    registry.state = 'disabled';
    registry.generation++;
    pending?.cancel();
    pending = null;
    clearTimeout(renderTimer);
    CONFIG = null;
    removeExistingCTA();
    registry.observer?.disconnect();
    registry.onMutation = null;
    document.removeEventListener('DOMContentLoaded', refresh);
    window.removeEventListener('popstate', navigation);
    window.removeEventListener('hashchange', navigation);
    historyRestorers.forEach(restore => restore());
  }
  registry.shutdown = shutdown;
  registry.onMutation = navigation;
  window.addEventListener('popstate', navigation);
  window.addEventListener('hashchange', navigation);
  // pushState/replaceState do not emit popstate; clear stale destinations synchronously.
  for (const method of ['pushState', 'replaceState']) {
    const original = window.history[method];
    const wrapped = function (...args) {
      const result = original.apply(this, args);
      navigation();
      return result;
    };
    window.history[method] = wrapped;
    historyRestorers.push(() => {
      if (window.history[method] === wrapped) window.history[method] = original;
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh, { once: true });
  } else {
    refresh();
  }
})();
