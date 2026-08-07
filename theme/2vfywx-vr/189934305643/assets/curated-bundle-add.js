document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-curated-bundle-add]');
  if (!btn) return;

  var variantA = btn.getAttribute('data-variant-a');
  var variantB = btn.getAttribute('data-variant-b');
  var label = btn.querySelector('.curated-bundle-btn-text');
  var originalText = label ? label.textContent : '';

  if (!variantA || !variantB) return;

  btn.disabled = true;
  if (label) label.textContent = 'Adding...';

  fetch(window.Shopify.routes.root + 'cart/add.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        { id: variantA, quantity: 1 },
        { id: variantB, quantity: 1 }
      ]
    })
  })
    .then(function (res) { return res.json(); })
    .then(function (res) {
      if (res.status === 422 || res.errors) {
        if (label) label.textContent = 'Unavailable';
        setTimeout(function () {
          btn.disabled = false;
          if (label) label.textContent = originalText;
        }, 2000);
        return;
      }
      if (label) label.textContent = 'Added';
      document.dispatchEvent(new CustomEvent('eurus:cart:items-changed'));
      document.dispatchEvent(new CustomEvent('eurus:product:added', { detail: { product: res } }));
      if (window.Alpine && Alpine.store('xMiniCart')) {
        Alpine.store('xMiniCart').openCart();
      }
      setTimeout(function () {
        btn.disabled = false;
        if (label) label.textContent = originalText;
      }, 2000);
    })
    .catch(function () {
      if (label) label.textContent = 'Error, try again';
      setTimeout(function () {
        btn.disabled = false;
        if (label) label.textContent = originalText;
      }, 2000);
    });
});
