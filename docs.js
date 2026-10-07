// arcgate API reference: Scalar configuration. Loaded after Scalar's standalone bundle.
(function () {
  // Single switch for offering the raw OpenAPI document from the reference page.
  //   "none"   no download link (current choice: the spec is the data source, not a product)
  //   "json"   a "Download OpenAPI Document" link on the intro
  var OPENAPI_DOWNLOAD = "none";

  // Operations are listed in the order a caller uses them, not alphabetically.
  // Tag and group order are not set here: the document's `tags` and `x-tagGroups`
  // (TAG_GROUPS in packages/core/src/openapi/document.ts) carry them, and Scalar follows the document.
  var OPERATION_ORDER = ["tradeSearch", "tradeQuote", "tradeSwap", "tradeSwapTx", "tradeReceipt", "tradeVenues", "agentSearch", "agentProfile", "agentWallet", "boxCreate", "boxTopUp", "boxStatus", "boxMessageList", "boxMessageFetch", "boxMessageDelete", "inboundCreate", "inboundList", "inboundDelete", "inboundRotate", "watchCreate", "watchList", "watchDelete", "webhookCreate", "webhookList", "webhookDelete", "webhookRotate", "webhookEnable", "telegramCreate", "telegramList", "telegramDelete", "telegramLink", "mcp", "mcpInfo", "health", "openapi", "agentRegistration", "agentKarmaManifest"];

  function rank(list, key) {
    var i = list.indexOf(key);
    return i === -1 ? list.length : i;
  }
  function operationKey(entry) {
    if (!entry) return "";
    return entry.operationId || (entry.operation && entry.operation.operationId) || entry.id || "";
  }

  // ---- Test Request pays with the visitor's wallet (x402) ----
  // Scalar sends every Test Request through customFetch. Calls to this API that answer 402, and
  // MCP tool calls that answer with a price, are paid with x402's own client (loaded on first use) and a signer over the visitor's EIP-1193
  // wallet, then retried. Nothing else is ever paid: other origins go straight to fetch, only Arc
  // USDC is accepted, and no single payment may exceed the largest price the API's own document lists.
  var API_ORIGIN = (function () {
    var meta = document.querySelector('meta[name="arcgate-api"]');
    try {
      return new URL(meta ? meta.getAttribute("content") : "").origin;
    } catch (e) {
      return null;
    }
  })();
  var X402_CDN = "https://cdn.jsdelivr.net/npm/@x402/";
  var USDC = "0x3600000000000000000000000000000000000000";
  var PAY_NETWORKS = ["eip155:5042002", "eip155:5042"]; // Arc testnet, Arc mainnet
  var ARC_TESTNET = {
    chainId: "0x4cef52",
    chainName: "Arc Testnet",
    rpcUrls: ["https://rpc.testnet.arc.io"],
    blockExplorerUrls: ["https://explorer.testnet.arc.io"],
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  };
  // x402 hands over viem-style typed data (no EIP712Domain type); eth_signTypedData_v4 needs it.
  var DOMAIN_FIELDS = [["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"], ["salt", "bytes32"]];

  async function ensureChain(ethereum, chainId) {
    var hex = "0x" + chainId.toString(16);
    if ((await ethereum.request({ method: "eth_chainId" })) === hex) return;
    try {
      await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (err) {
      if (!(err && err.code === 4902 && hex === ARC_TESTNET.chainId)) throw err;
      await ethereum.request({ method: "wallet_addEthereumChain", params: [ARC_TESTNET] });
    }
  }

  function walletSigner(ethereum, address) {
    return {
      address: address,
      signTypedData: async function (msg) {
        // Wallets only sign typed data for the chain they're on.
        await ensureChain(ethereum, Number(msg.domain.chainId));
        var types = Object.assign({}, msg.types);
        if (!types.EIP712Domain) {
          types.EIP712Domain = DOMAIN_FIELDS.filter(function (f) {
            return msg.domain[f[0]] !== undefined;
          }).map(function (f) {
            return { name: f[0], type: f[1] };
          });
        }
        var data = JSON.stringify({ domain: msg.domain, types: types, primaryType: msg.primaryType, message: msg.message }, function (_k, v) {
          return typeof v === "bigint" ? v.toString() : v;
        });
        return ethereum.request({ method: "eth_signTypedData_v4", params: [address, data] });
      },
    };
  }

  // The most any operation can charge: the largest x-payment amount (a flat price or a swap tier) in
  // the API's live GET /openapi.json, read when the wallet is first connected on the page. A
  // price_max raised by `config:set` after that applies once the page is reloaded. A failed read
  // refuses payment.
  async function maxPayment() {
    var res = await fetch(API_ORIGIN + "/openapi.json");
    if (!res.ok) throw new Error("Could not read the API's prices (GET /openapi.json answered " + res.status + "), so nothing was paid.");
    var doc = await res.json();
    var max = 0n;
    Object.values(doc.paths).forEach(function (methods) {
      Object.values(methods).forEach(function (operation) {
        var payment = operation["x-payment"];
        if (!payment) return;
        (payment.tiers || [payment]).forEach(function (price) {
          if (BigInt(price.baseUnits) > max) max = BigInt(price.baseUnits);
        });
      });
    });
    return max.toString();
  }

  // One x402 client per connected account, made on the first 402 (free calls never prompt).
  var payerPromise = null;
  function payer() {
    if (payerPromise) return payerPromise;
    payerPromise = (async function () {
      var ethereum = window.ethereum;
      if (!ethereum) {
        throw new Error("This call is paid in USDC with x402. Install a browser wallet (MetaMask, or any EIP-1193 wallet) holding USDC on Arc, then send it again.");
      }
      if (ethereum.on) {
        ethereum.on("accountsChanged", function () {
          payerPromise = null;
        });
      }
      var accounts = await ethereum.request({ method: "eth_requestAccounts" });
      var maxAmountPerPayment = await maxPayment();
      var mods = await Promise.all([import(X402_CDN + "core@2.27.0/client/+esm"), import(X402_CDN + "evm@2.27.0/exact/client/+esm")]);
      var signer = walletSigner(ethereum, accounts[0]);
      var client = mods[0].x402Client.fromConfig({
        schemes: PAY_NETWORKS.map(function (network) {
          return { network: network, client: new mods[1].ExactEvmScheme(signer) };
        }),
        spendControls: {
          allowedAssets: PAY_NETWORKS.map(function (network) {
            return { network: network, asset: USDC, maxAmountPerPayment: maxAmountPerPayment };
          }),
        },
      });
      return new mods[0].x402HTTPClient(client);
    })();
    payerPromise.catch(function () {
      payerPromise = null;
    });
    return payerPromise;
  }

  // The gateway's MCP endpoint (MCP_PATH in packages/core/src/openapi/document.ts).
  var MCP_PATH = "/mcp";

  async function payFetch(input, init) {
    var request = new Request(input, init);
    var url = new URL(request.url);
    if (url.origin !== API_ORIGIN) return fetch(request);
    // The request examples' PAYMENT-SIGNATURE is a placeholder; a real one is added below.
    request.headers.delete("payment-signature");
    var mcpPath = url.pathname.replace(/\/+$/, "").toLowerCase();
    var isMcp = request.method === "POST" && mcpPath === MCP_PATH;
    var mcpCall = isMcp ? await request.clone().text() : null;
    var response = await fetch(request.clone());
    try {
      if (response.status === 402) return await pay(request, response);
      var mcpPrice = isMcp ? await priceOfMcpCall(response) : null;
      if (mcpPrice) return await payMcp(request, mcpCall, mcpPrice);
      return response;
    } catch (err) {
      // Shown in the response panel. A thrown error would read as "Failed to connect".
      var body = { error: { code: "payment_not_sent", message: (err && err.message) || String(err) } };
      return new Response(JSON.stringify(body, null, 2), { status: 402, statusText: "Payment Required", headers: { "content-type": "application/json" } });
    }
  }

  // A paid MCP tool called without payment answers 200 with result.isError and the x402
  // requirements in result.structuredContent (MCP has no 402).
  async function priceOfMcpCall(response) {
    var data = await response
      .clone()
      .json()
      .catch(function () {
        return null;
      });
    var price = data && data.result && data.result.isError ? data.result.structuredContent : null;
    return price && price.x402Version && Array.isArray(price.accepts) ? price : null;
  }

  // The same JSON-RPC call again, with the signed payment in params._meta["x402/payment"]: MCP
  // carries payment in the call, not in a header. The receipt comes back in result._meta.
  async function payMcp(request, callText, paymentRequired) {
    var http = await payer();
    var payload = await http.createPaymentPayload(paymentRequired);
    var call = JSON.parse(callText);
    call.params = call.params || {};
    call.params._meta = Object.assign({}, call.params._meta, { "x402/payment": payload });
    return fetch(new Request(request, { body: JSON.stringify(call) }));
  }

  async function pay(request, response) {
    var http = await payer();
    var body = await response
      .clone()
      .json()
      .catch(function () {
        return null;
      });
    var paymentRequired = http.getPaymentRequiredResponse(function (name) {
      return response.headers.get(name);
    }, body);
    var payload = await http.createPaymentPayload(paymentRequired);
    var paid = new Request(request);
    var headers = http.encodePaymentSignatureHeader(payload);
    Object.keys(headers).forEach(function (name) {
      paid.headers.set(name, headers[name]);
    });
    return fetch(paid);
  }

  window.Scalar.createApiReference("#app", {
    url: "./openapi.json",
    slug: "arcgate",
    title: "arcgate API reference",
    theme: "none",
    withDefaultFonts: false,
    // Scalar injects its component styles after <head>'s stylesheets, so equal-specificity overrides
    // in theme.css would lose. customCss is emitted after Scalar's own styles: importing theme.css
    // there puts the overrides last in the cascade. (The <link> in <head> still styles the static
    // header and footer before Scalar mounts; same file, one fetch.)
    customCss: '@import url("./theme.css");',
    layout: "modern",
    showSidebar: true,
    // Land on the introduction with no operation group expanded.
    defaultOpenFirstTag: false,
    operationTitleSource: "summary",
    hideModels: false,
    documentDownloadType: OPENAPI_DOWNLOAD,
    // Test Request sends straight to the API (never Scalar's default proxy, which would carry the
    // payment header through a third party) and pays through payFetch above. No full API client.
    hideTestRequestButton: false,
    proxyUrl: "",
    customFetch: payFetch,
    hideClientButton: true,
    hideDarkModeToggle: false,
    showDeveloperTools: "never",
    agent: { disabled: true },
    mcp: { disabled: true },
    telemetry: false,
    defaultHttpClient: { targetKey: "js", clientKey: "fetch" },
    // Request examples on the paid operations show what really goes in PAYMENT-SIGNATURE instead of
    // "YOUR_SECRET_TOKEN". No preferredSecurityScheme: that would add the header to free operations too.
    authentication: {
      securitySchemes: { x402: { value: "<base64 x402 payment payload>" } },
    },
    // Keep the clients an x402 caller actually uses: curl, fetch, Node, Python, Go.
    hiddenClients: { c: true, clojure: true, csharp: true, dart: true, fsharp: true, http: true, java: true, kotlin: true, objc: true, ocaml: true, php: true, powershell: true, r: true, ruby: true, rust: true, swift: true },
    orderSchemaPropertiesBy: "preserve",
    orderRequiredPropertiesFirst: true,
    operationsSorter: function (a, b) {
      return rank(OPERATION_ORDER, operationKey(a)) - rank(OPERATION_ORDER, operationKey(b));
    },
  });

  // Keep the static header and footer on the same ground as Scalar: Scalar owns the color mode
  // (its toggle writes localStorage "colorMode" and sets body.dark-mode / body.light-mode).
  // The theme-color metas follow the toggle too, not just the system preference.
  var root = document.documentElement;
  var themeColors = document.querySelectorAll('meta[name="theme-color"]');
  function syncMode() {
    var cls = document.body.classList;
    var dark = cls.contains("dark-mode") ? true : cls.contains("light-mode") ? false : null;
    if (dark === null) return;
    root.classList.toggle("ag-dark", dark);
    for (var i = 0; i < themeColors.length; i++) {
      themeColors[i].setAttribute("content", dark ? "#101815" : "#EEF1EB");
    }
  }
  new MutationObserver(syncMode).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  syncMode();

  // The intro's x402 example is written once per language, as adjacent fenced blocks (intro.md).
  // Show the block matching the client picked under Client Libraries, read from the label the card
  // shows ("JavaScript Fetch", "Shell Curl", "Python http.client", ...); a client with no block of
  // its own (Go, ...) gets the JavaScript one. Polled, not observed: Scalar re-renders the card and
  // its markdown, and doesn't persist a tab click anywhere we could listen to.
  var EXAMPLE_LANGS = ["language-js", "language-python", "language-bash"];
  function exampleLang(pre) {
    var code = pre.querySelector("code");
    if (!code) return null;
    for (var i = 0; i < EXAMPLE_LANGS.length; i++) if (code.classList.contains(EXAMPLE_LANGS[i])) return EXAMPLE_LANGS[i];
    return null;
  }
  function selectedLang() {
    var card = document.querySelector(".scalar-reference-intro-clients");
    var label = card ? card.textContent.split("Select from all clients").pop().trim() : "";
    if (/^Shell/.test(label)) return "language-bash";
    if (/^Python/.test(label)) return "language-python";
    return "language-js";
  }
  function syncExamples() {
    var want = selectedLang();
    var pres = document.querySelectorAll(".introduction-description-heading pre");
    // Groups: runs of adjacent per-language blocks. A lone code block is never hidden.
    var groups = [];
    for (var i = 0; i < pres.length; i++) {
      if (!exampleLang(pres[i])) continue;
      var prev = pres[i].previousElementSibling;
      var last = groups[groups.length - 1];
      if (last && prev === last[last.length - 1]) last.push(pres[i]);
      else groups.push([pres[i]]);
    }
    groups.forEach(function (group) {
      if (group.length < 2) return;
      var has = group.some(function (pre) { return exampleLang(pre) === want; });
      var show = has ? want : "language-js";
      group.forEach(function (pre) {
        var display = exampleLang(pre) === show ? "" : "none";
        if (pre.style.display !== display) pre.style.display = display;
      });
    });
  }
  // The Prices tables are the only ones with a numeric last column (theme.css styles [data-price]).
  // The sanitizer strips classes, so mark them by the header: the last one starts with "USDC". A price
  // cell that reads "free" is marked too (data-free), so only free reads green, whatever row it is on.
  function tagPriceTables() {
    var tables = document.querySelectorAll(".markdown table");
    for (var i = 0; i < tables.length; i++) {
      var heads = tables[i].querySelectorAll("th");
      var last = heads.length ? heads[heads.length - 1].textContent.trim() : "";
      if (!/^USDC/.test(last)) continue;
      if (!tables[i].hasAttribute("data-price")) tables[i].setAttribute("data-price", "");
      var prices = tables[i].querySelectorAll("td:last-child");
      for (var j = 0; j < prices.length; j++) {
        if (prices[j].textContent.trim() === "free" && !prices[j].hasAttribute("data-free")) prices[j].setAttribute("data-free", "");
      }
    }
  }
  setInterval(function () { syncExamples(); tagPriceTables(); }, 300);
  syncExamples();
  tagPriceTables();
})();
