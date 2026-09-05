(function () {

  const LOADER_SCRIPT =
    document.currentScript;

  const MANIFEST_URL =
    "https://raw.githubusercontent.com/an13501112545-create/chinaflow-script/main/manifest.json";

  const FALLBACK_ENGINE_URL =
    "https://cdn.jsdelivr.net/gh/an13501112545-create/chinaflow-script@0e8393f6c9685f55408ef400cf94f3fd8807da25/chinaflow.js";


  function resolveHttpsAttribute(name) {

    try {

      const value =
        LOADER_SCRIPT?.getAttribute(name);

      if (
        typeof value === "string" &&
        value.trim() !== "" &&
        value.trim().startsWith("https://")
      ) {
        return value.trim();
      }

    } catch (error) {

      console.warn(
        "[ChinaFlow Loader v0.2] Attribute resolution failed:",
        name,
        error
      );

    }

    return null;

  }


  const CONFIG_OVERRIDE_URL =
    resolveHttpsAttribute(
      "data-chinaflow-config"
    );

  const ENGINE_OVERRIDE_URL =
    resolveHttpsAttribute(
      "data-chinaflow-engine"
    );


  async function loadChinaFlow() {

    let engineUrl =
      FALLBACK_ENGINE_URL;

    if (ENGINE_OVERRIDE_URL) {

      engineUrl =
        ENGINE_OVERRIDE_URL;

    } else {

      try {

        const response = await fetch(
          MANIFEST_URL + "?t=" + Date.now(),
          {
            cache: "no-store"
          }
        );

        if (!response.ok) {
          throw new Error(
            "Manifest request failed: " +
            response.status
          );
        }

        const manifest =
          await response.json();

        if (
          manifest &&
          manifest.engine_url
        ) {

          engineUrl =
            manifest.engine_url;

        }

      } catch (error) {

        console.warn(
          "[ChinaFlow Loader v0.2] Using fallback engine",
          error
        );

      }

    }


    const script =
      document.createElement("script");

    script.src =
      engineUrl;

    script.async =
      true;

    script.setAttribute(
      "data-chinaflow-loader",
      "true"
    );

    if (CONFIG_OVERRIDE_URL) {
      script.setAttribute(
        "data-chinaflow-config",
        CONFIG_OVERRIDE_URL
      );
    }

    script.onload =
      function () {

        console.log(
          "[ChinaFlow Loader v0.2] Engine loaded:",
          engineUrl
        );

      };

    script.onerror =
      function () {

        console.error(
          "[ChinaFlow Loader v0.2] Engine failed:",
          engineUrl
        );

      };


    document.head.appendChild(
      script
    );

  }


  loadChinaFlow();

})();
