/* Keycloak 26.8.2 v2 uses a different input ID on the OTP/reauthentication page.
   Repair the label association only; never read credentials or change form actions. */
document.addEventListener('DOMContentLoaded', () => {
  const account = document.getElementById('kc-attempted-username');
  const label = account?.closest('.pf-v5-c-form__group')?.querySelector('label[for="username"]');
  if (label) label.htmlFor = account.id;

  // The inherited field macro emits an empty flag when a field has no error.
  for (const input of document.querySelectorAll('input[aria-invalid=""]')) {
    input.removeAttribute('aria-invalid');
  }
});
