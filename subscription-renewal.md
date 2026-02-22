# Subscription Renewal

Force open the paywall to renew subscription even when user has active
subscription but insufficient tokens.

**Tokenized Paywalls Only:** This API only works with paywall tokenization
enabled. Learn more about paywall tokenization.

**API Provider Required:** Before using this API, please create an API provider.

## Overview

The `paywall.renew()` function is designed for scenarios where users have
active subscriptions but have exhausted their token allocation. Unlike
`paywall.open()`, this function bypasses the standard paywall opening logic and
forces the paywall to appear even for users with active subscriptions.

**Key Features:**

- **Token replenishment** - Allows users to add more tokens to their account
- **Active subscription override** - Opens paywall even with active subscription
- **Error handling integration** - Works seamlessly with API provider error
  responses
- **Promise-based** - Returns promise that resolves on payment or rejects on
  cancellation

## When to Use

Use `paywall.renew()` when:

- API provider returns `not-enough-queries` error
- User has active subscription but zero token balance
- User wants to purchase additional tokens beyond their plan allocation

## API Reference

### Method Signature

```typescript
paywall.renew(): Promise<void>
```

### Return Value

- **Resolves** when user completes payment successfully
- **Rejects** when user closes paywall without payment

## Basic Usage

### Simple Renewal

```javascript
const handleTokenRenewal = async () => {
  try {
    await paywall.renew();
    console.log("Tokens renewed successfully");

    // Refresh user balance information
    const userInfo = await paywall.getUser();
    console.log("Updated balances:", userInfo.balances);
  } catch (error) {
    console.log("User canceled renewal");
  }
};
```

## Practical Examples

### Standard Request with Renewal

```javascript
const makeRequestWithRenewal = async (requestUrl, options) => {
  try {
    const response = await paywall.makeRequest(requestUrl, options);
    return response;
  } catch (error) {
    if (error === "not-enough-queries") {
      try {
        // Open paywall for token renewal
        await paywall.renew();

        // Get updated balances
        await paywall.getUser();

        // Retry the original request
        return await paywall.makeRequest(requestUrl, options);
      } catch (renewError) {
        // User canceled renewal
        throw new Error("Token renewal was canceled");
      }
    } else if (error === "Unauthorized" || error === "access-denied") {
      // Handle authentication
      await paywall.open();
      throw new Error("Authentication required");
    }
    throw error;
  }
};
```

## Best Practices

### 1. Always Update User Data After Renewal

```javascript
const renewAndUpdate = async () => {
  try {
    await paywall.renew();

    // Always fetch updated user data after renewal
    const userInfo = await paywall.getUser();
    updateUIWithNewBalances(userInfo.balances);
  } catch (error) {
    console.log("Renewal canceled");
  }
};
```

### 2. Inform Users About Token Status

```javascript
const showTokenStatus = async () => {
  try {
    const userInfo = await paywall.getUser();
    const standardTokens = userInfo.balances.find((b) => b.type === "standard");

    if (standardTokens?.count === 0) {
      showMessage(
        "You have no tokens remaining. Click here to renew your subscription."
      );
    } else if (standardTokens?.count < 5) {
      showMessage(`Low token warning: ${standardTokens.count} tokens remaining.`);
    }
  } catch (error) {
    console.error("Failed to check token status:", error);
  }
};
```
