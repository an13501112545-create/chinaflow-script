(function () {

  const MANIFEST_URL =
    "https://raw.githubusercontent.com/an13501112545-create/chinaflow-script/main/manifest.json";

  const FALLBACK_ENGINE_URL =
    "https://cdn.jsdelivr.net/gh/an13501112545-create/chinaflow-script@0e8393f6c9685f55408ef400cf94f3fd8807da25/chinaflow.js";


  async function loadChinaFlow() {

    let engineUrl =
      FALLBACK_ENGINE_URL;

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
        "[ChinaFlow Loader] Using fallback engine",
        error
      );

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

    script.onload =
      function () {

        console.log(
          "[ChinaFlow Loader] Engine loaded:",
          engineUrl
        );

      };

    script.onerror =
      function () {

        console.error(
          "[ChinaFlow Loader] Engine failed:",
          engineUrl
        );

      };


    document.head.appendChild(
      script
    );

  }


  loadChinaFlow();

})();
