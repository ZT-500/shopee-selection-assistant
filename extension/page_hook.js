// 在 Shopee 页面的 main world 里运行。
// 覆盖 window.fetch，把命中的 API 响应通过 postMessage 发给 content script。
(function () {
  if (window.__shopeeAssistantHooked) return;
  window.__shopeeAssistantHooked = true;

  const interestingPatterns = [
    /\/api\/v\d+\/search\/search_items/,
    /\/api\/v\d+\/search\/product_search/,
    /\/api\/v\d+\/item\/get/,
    /\/api\/v\d+\/pdp\/get/,
    /\/api\/v\d+\/recommend/,
    /\/api\/v\d+\/shop\/get/,
    /\/api\/v\d+\/item\/get_ratings/
  ];

  const isInteresting = (url) => interestingPatterns.some((re) => re.test(url));

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';
      if (isInteresting(url)) {
        // 克隆响应再读，不影响原本的 consumer
        const clone = resp.clone();
        clone
          .json()
          .then((body) => {
            window.postMessage(
              {
                type: 'SHOPEE_ASSISTANT_API_RESPONSE',
                url: url,
                status: resp.status,
                body: body
              },
              '*'
            );
          })
          .catch(() => {});
      }
    } catch (e) {
      /* 静默 */
    }
    return resp;
  };
})();
