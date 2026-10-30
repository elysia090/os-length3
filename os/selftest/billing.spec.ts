import {expect, test} from './fixtures.ts';

// Paying, as a person does it on the Remote with the plan (global-setup.ts: LENGTH3_PLAN=1, its Stripe the
// stand-in in test mode): a tier chosen on the Plan, Stripe's Checkout with Stripe's test cards (4242 pays,
// 0002 is declined, 3155 asks for 3-D Secure first), and the portal, where the tier is changed and the
// subscription cancelled and kept; each time back on the Plan, which says once how it went. Each test's person
// is signed in already (fixtures.ts, planSignedIn) and goes from Home to Remote, where the Plan is.

test('a tier paid for with 4242 in Checkout is the plan shown as yours after, its use against what it keeps', async ({planSignedIn: app}) => {
  await app.rail.go('remote');
  await app.remote.part('Plan').click();
  await expect(app.remote.tier('Free plan')).toHaveAttribute('aria-current', 'true');
  // Subscribe asks what is bought first: the tier, what it costs, how it is billed and ends.
  await app.remote.tier('Pro Plan').getByRole('button', {name: 'Subscribe'}).click();
  const ask = app.remote.asking('Pro');
  await expect(ask).toContainText('$14 / month');
  await expect(ask).toContainText('Renews automatically until cancelled');
  await ask.getByRole('button', {name: 'Proceed to payment'}).click();

  // Stripe's Checkout, in test mode: the tier and what it keeps at the left, the card at the right.
  await expect(app.page.getByText('Test mode', {exact: true})).toBeVisible();
  await expect(app.page.getByText('256 GB on the Remote')).toBeVisible();
  await app.stripe.pay('4242 4242 4242 4242');

  await app.settled();
  await expect(app.remote.told).toHaveText('Payment successful: you are now on Pro.');
  await expect(app.remote.plan.getByText(/^Pro Plan · /)).toBeVisible();
  await expect(app.remote.tier('Pro Plan')).toHaveAttribute('aria-current', 'true');
  await expect(app.remote.tier('Free plan')).not.toHaveAttribute('aria-current', 'true');
  await expect(app.remote.plan.getByRole('meter', {name: 'Remote storage used'})).toBeVisible();
  await expect(app.remote.plan).toContainText('of 256 GB');
  // Said once: drawn again (the part chosen again), it is not said again.
  await app.remote.part('Repos').click();
  await app.rail.go('home');
  await app.rail.go('remote');
  await app.remote.part('Plan').click();
  await expect(app.remote.tier('Pro Plan')).toHaveAttribute('aria-current', 'true');
});

test('a card that is declined is said under it in Checkout and nothing is sent; Back says nothing was charged', async ({planSignedIn: app}) => {
  await app.rail.go('remote');
  await app.remote.subscribe('Go');
  await app.stripe.pay('4000 0000 0000 0002');
  await expect(app.stripe.cardSays).toHaveText('Your card was declined.');
  await expect(app.stripe.number).toHaveAttribute('aria-invalid', 'true');
  // What is wrong before it is tried is said there too, without asking anyone.
  await app.stripe.number.fill('4242 4242 4242 4241');
  await app.page.getByRole('button', {name: 'Subscribe'}).click();
  await expect(app.stripe.cardSays).toHaveText('Your card number is invalid.');

  await app.page.getByRole('link', {name: 'Back to length3'}).click();
  await app.settled();
  await expect(app.remote.told).toHaveText('Payment cancelled: no charge applied and plan remains unchanged.');
  // Free as it was: its own card current, nothing said again beside the plans.
  await expect(app.remote.tier('Free plan')).toHaveAttribute('aria-current', 'true');
  await expect(app.remote.plan.getByText(/^Free plan · /)).toHaveCount(0);
});

test('3-D Secure with 3155: Fail goes back to Checkout and says so with nothing paid; Complete pays', async ({planSignedIn: app}) => {
  await app.rail.go('remote');
  await app.remote.subscribe('Max');
  await app.stripe.pay('4000 0025 0000 3155');
  await app.stripe.secure('Fail');
  await expect(app.stripe.cardSays).toHaveText('We are unable to authenticate your payment method. Please choose a different payment method and try again.');
  await expect(app.page.getByText('Subscribe to Max', {exact: true})).toBeVisible();

  await app.stripe.pay('4000 0025 0000 3155');
  await app.stripe.secure('Complete');
  await app.settled();
  await expect(app.remote.told).toHaveText('Payment successful: you are now on Max.');
  await expect(app.remote.tier('Max Plan')).toHaveAttribute('aria-current', 'true');
});

test('a tier changed from the Plan is confirmed in Stripe\'s portal, and the Plan says the new one once back', async ({planSignedIn: app}) => {
  await app.rail.go('remote');
  await app.remote.subscribe('Go');
  await app.stripe.pay('4242 4242 4242 4242');
  await expect(app.remote.tier('Go Plan')).toHaveAttribute('aria-current', 'true');

  // Up: the portal at the step that changes it, what it costs now, Confirm, and back.
  await app.remote.tier('Pro Plan').getByRole('button', {name: 'Upgrade'}).click();
  await expect(app.page.getByRole('heading', {name: 'Confirm your updated plan'})).toBeVisible();
  await expect(app.page.getByText('Amount due today', {exact: true})).toBeVisible();
  await app.page.getByRole('button', {name: 'Confirm'}).click();
  await app.settled();
  await expect(app.remote.told).toHaveText('You are now on Pro.');
  await expect(app.remote.tier('Pro Plan')).toHaveAttribute('aria-current', 'true');

  // Down again from the portal's own list, under Manage plan.
  await app.remote.plan.getByRole('button', {name: 'Manage plan'}).click();
  await expect(app.stripe.subscription).toContainText('Pro');
  await app.page.getByRole('link', {name: 'Update subscription'}).click();
  await app.page.getByRole('link', {name: 'Select Go'}).click();
  await expect(app.page.getByText('Credited to your next invoice', {exact: true})).toBeVisible();
  await app.page.getByRole('button', {name: 'Confirm'}).click();
  await expect(app.page.getByRole('status')).toHaveText('Your subscription has been updated.');
  await expect(app.page.getByRole('table')).toContainText('Go → Pro');
  await app.page.getByRole('link', {name: 'Return to length3'}).click();
  await app.settled();
  await expect(app.remote.told).toHaveText('You are now on Go.');
  await expect(app.remote.tier('Go Plan')).toHaveAttribute('aria-current', 'true');
});

test('cancelled in the portal, it stays to the period\'s end and the Plan says until when; Renew plan keeps it', async ({planSignedIn: app}) => {
  await app.rail.go('remote');
  await app.remote.subscribe('Pro');
  await app.stripe.pay('4242 4242 4242 4242');
  await expect(app.remote.tier('Pro Plan')).toHaveAttribute('aria-current', 'true');

  await app.remote.plan.getByRole('button', {name: 'Manage plan'}).click();
  await app.page.getByRole('link', {name: 'Cancel subscription'}).click();
  await app.page.getByRole('button', {name: 'Cancel plan'}).click();
  await expect(app.stripe.subscription).toContainText('Your subscription will be canceled on');
  await app.page.getByRole('link', {name: 'Return to length3'}).click();
  await app.settled();
  await expect(app.remote.told).toHaveText(/^Subscription cancelled: Pro remains active until .+; no further charges\.$/);
  await expect(app.remote.plan).toContainText(/Expires on /);
  // Still Pro until then.
  await expect(app.remote.tier('Pro Plan')).toHaveAttribute('aria-current', 'true');

  await app.remote.plan.getByRole('button', {name: 'Manage plan'}).click();
  await app.page.getByRole('button', {name: 'Renew plan'}).click();
  await expect(app.stripe.subscription).toContainText('Your plan renews on');
  await app.page.getByRole('link', {name: 'Return to length3'}).click();
  await app.settled();
  await expect(app.remote.told).toHaveText(/^Pro goes on: it renews /);
  await expect(app.remote.plan).toContainText(/Renews /);
});
