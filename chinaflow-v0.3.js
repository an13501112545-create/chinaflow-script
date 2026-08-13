(function () {

  const CHINAFLOW_CONFIG_URL =
    "https://raw.githubusercontent.com/an13501112545-create/chinaflow-script/main/config.json";

  let CONFIG = null;


  // =========================================================
  // Load config
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
          "Config load failed: " +
          response.status
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
  // Helpers
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


  // =========================================================
  // Read page content
  // =========================================================

  function readPageContext() {

    const title =
      document.querySelector("h1")?.innerText ||
      document.title ||
      "";

    const metaDescription =
      document
        .querySelector(
          'meta[name="description"]'
        )
        ?.getAttribute("content") ||
      "";

    const bodyText =
      document.body?.innerText ||
      "";

    const combined =
      normalizeText(
        title +
        " " +
        metaDescription +
        " " +
        bodyText.slice(0, 12000)
      );

    return {

      path:
        normalizePath(
          window.location.pathname
        ),

      title:
        normalizeText(title),

      metaDescription:
        normalizeText(
          metaDescription
        ),

      text:
        combined

    };

  }


  // =========================================================
  // Exact path rule
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
  // China travel intent detection
  // =========================================================

  function detectChinaTravelIntent(
    context
  ) {

    const text =
      context.text;


    const chinaSignals = [

      "china",
      "chinese travel",
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
          text.includes(keyword)
      );


    const travelMatches =
      travelSignals.filter(
        keyword =>
          text.includes(keyword)
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
  // Find generic hotel rule in config
  // =========================================================

  function findGenericChinaHotelRule() {

    if (
      !CONFIG ||
      !Array.isArray(CONFIG.rules)
    ) {
      return null;
    }


    return CONFIG.rules.find(
      function (rule) {

        if (
          rule.enabled === false
        ) {
          return false;
        }

        return (
          rule.product === "hotel" &&
          rule.placement ===
            "flightflex_blog_china_inbound_hotels_generic_test"
        );

      }
    );

  }


  // =========================================================
  // Intelligent rule selection
  // =========================================================

  function selectRule() {

    const context =
      readPageContext();


    /*
     * Priority 1:
     * Exact publisher rule
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
     * Priority 2:
     * Content intent recognition
     */
    if (
      context.path.startsWith(
        "/post/"
      )
    ) {

      const intent =
        detectChinaTravelIntent(
          context
        );


      console.log(
        "[ChinaFlow v0.3] Content analysis:",
        {
          title:
            context.title,
          score:
            intent.score,
          china:
            intent.chinaMatches,
          travel:
            intent.travelMatches
        }
      );


      if (
        intent.matched
      ) {

        const genericHotelRule =
          findGenericChinaHotelRule();


        if (
          genericHotelRule
        ) {

          console.log(
            "[ChinaFlow v0.3] China travel intent detected → generic hotel"
          );

          return {
            ...genericHotelRule,

            id:
              "auto-china-travel-hotel",

            placement:
              "flightflex_auto_china_travel_hotel",

            eyebrow:
              "PLAN YOUR CHINA TRIP",

            title:
              "Find Hotels for Your China Trip",

            subtitle:
              "Compare hotel options and book your stay on Trip.com"
          };

        }

      }

    }


    console.log(
      "[ChinaFlow v0.3] No monetization intent detected"
    );

    return null;

  }


  // =========================================================
  // Remove CTA
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
  // Render CTA
  // =========================================================

  function renderCTA(rule) {

    if (!rule) return;


    const wrap =
      document.createElement("div");

    wrap.id =
      "chinaflow-auto-cta";

    wrap.dataset.publisher =
      CONFIG?.publisher || "";

    wrap.dataset.product =
      rule.product || "";

    wrap.dataset.placement =
      rule.placement || "";


    Object.assign(
      wrap.style,
      {

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

      }
    );


    const link =
      document.createElement("a");

    link.href =
      rule.url;

    link.target =
      "_blank";

    link.rel =
      "noopener sponsored";


    Object.assign(
      link.style,
      {

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

        cursor: "pointer"

      }
    );


    const icon =
      document.createElement("div");

    icon.textContent =
      rule.icon || "▣";


    Object.assign(
      icon.style,
      {

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

      }
    );


    const content =
      document.createElement("div");


    Object.assign(
      content.style,
      {
        flex: "1",
        minWidth: "0"
      }
    );


    const eyebrow =
      document.createElement("div");

    eyebrow.textContent =
      rule.eyebrow || "";


    Object.assign(
      eyebrow.style,
      {

        marginBottom: "3px",

        fontSize: "10px",

        lineHeight: "1.2",

        fontWeight: "700",

        letterSpacing: "1.1px",

        color:
          "rgba(255,255,255,0.72)"

      }
    );


    const title =
      document.createElement("div");

    title.textContent =
      rule.title || "";


    Object.assign(
      title.style,
      {

        fontSize: "17px",

        lineHeight: "1.35",

        fontWeight: "700",

        color: "#ffffff"

      }
    );


    const subtitle =
      document.createElement("div");

    subtitle.textContent =
      rule.subtitle || "";


    Object.assign(
      subtitle.style,
      {

        marginTop: "3px",

        fontSize: "12px",

        lineHeight: "1.3",

        color:
          "rgba(255,255,255,0.78)"

      }
    );


    const arrow =
      document.createElement("div");

    arrow.textContent =
      "→";


    Object.assign(
      arrow.style,
      {

        width: "38px",

        minWidth: "38px",

        marginLeft: "12px",

        textAlign: "center",

        fontSize: "24px",

        color: "#ffffff"

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
  // Evaluate
  // =========================================================

  async function evaluatePage() {

    removeExistingCTA();

    await loadConfig();

    if (!CONFIG) {
      return;
    }


    /*
     * Give Wix Blog enough time
     * to render article content.
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
      renderCTA(rule);
    }

  }


  // =========================================================
  // Start
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
  // Wix SPA navigation
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
      childList: true,
      subtree: true
    }
  );


})();
