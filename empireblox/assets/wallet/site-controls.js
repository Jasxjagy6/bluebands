/* Keep account inputs, the receive address and intentional copy buttons usable. */
const editable = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
document.addEventListener('copy', event => {
  if (!event.target.closest?.(editable) && !document.activeElement?.closest(editable)) event.preventDefault();
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && ['+', '=', '-', '_', '0', 'Add', 'Subtract'].includes(event.key)) event.preventDefault();
});
document.addEventListener('wheel', event => {
  if (event.ctrlKey || event.metaKey) event.preventDefault();
}, {passive:false});
for (const gesture of ['gesturestart', 'gesturechange']) document.addEventListener(gesture, event => event.preventDefault(), {passive:false});
