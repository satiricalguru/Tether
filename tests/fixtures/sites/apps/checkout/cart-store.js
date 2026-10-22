// Cart state for the checkout stub, kept in sessionStorage.
window.CART_KEY = 'checkout:cart';
window.DEFAULT_CART = [
  { id: 'mug', name: 'Enamel Trail Mug', price: 18, qty: 1 },
  { id: 'socks', name: 'Merino Wool Socks', price: 12, qty: 2 },
  { id: 'map', name: 'Waterproof Trail Map', price: 9, qty: 1 },
];
window.loadCart = () => {
  const raw = sessionStorage.getItem(window.CART_KEY);
  if (raw) return JSON.parse(raw);
  sessionStorage.setItem(window.CART_KEY, JSON.stringify(window.DEFAULT_CART));
  return window.DEFAULT_CART.slice();
};
window.saveCart = (c) => sessionStorage.setItem(window.CART_KEY, JSON.stringify(c));
window.cartTotal = (c) => c.reduce((n, i) => n + i.price * i.qty, 0);
