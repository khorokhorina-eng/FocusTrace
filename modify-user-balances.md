# Modify User Balances

Modify user token balances in test paywalls for testing and development
purposes.

**Test Mode Only:** This API only works with test payment processors and is
intended for development and testing purposes only.

**Tokenized Paywalls Only:** This feature only works with tokenized paywalls.
Learn more about paywall tokenization.

## Overview

The modify balances API allows you to withdraw or deposit token balances for
users in test paywalls. This is useful for:

- **Testing scenarios** - Simulate different balance states
- **Development** - Test your application with various token levels
- **QA testing** - Verify behavior with low/high balances
- **Demo preparation** - Set up specific balance states for demonstrations

## API Reference

### Endpoint

```
POST https://onlineapp.pro/api/v1/test/withdraw-balances
```

### Request Body

```json
{
  "paywall_id": 100,
  "user_id": "320f173b-d831-4c90-8746-fd22aa8fe673",
  "tokens": 10000
}
```

### Parameters

| Parameter    | Type   | Required | Description                                                             |
| ------------ | ------ | -------- | ----------------------------------------------------------------------- |
| `paywall_id` | number | Yes      | Your paywall ID from personal cabinet                                   |
| `user_id`    | string | Yes      | User ID from `paywall.getUser()` response                               |
| `tokens`     | number | No       | Sets balances to specified value. If not provided, balances set to zero |

## Basic Usage

### Set Specific Balance

```javascript
const setUserBalance = async (paywallId, userId, tokens) => {
  try {
    const response = await fetch(
      "https://onlineapp.pro/api/v1/test/withdraw-balances",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          paywall_id: paywallId,
          user_id: userId,
          tokens: tokens,
        }),
      }
    );

    if (response.ok) {
      console.log(`Balance set to ${tokens} tokens for user ${userId}`);
      return true;
    }
    console.error("Failed to set balance:", response.statusText);
    return false;
  } catch (error) {
    console.error("Error setting balance:", error);
    return false;
  }
};

// Usage
await setUserBalance(100, "user-id-here", 5000);
```

### Reset Balance to Zero

```javascript
const resetUserBalance = async (paywallId, userId) => {
  try {
    const response = await fetch(
      "https://onlineapp.pro/api/v1/test/withdraw-balances",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          paywall_id: paywallId,
          user_id: userId,
          // No tokens parameter = set to zero
        }),
      }
    );

    if (response.ok) {
      console.log(`Balance reset to 0 for user ${userId}`);
      return true;
    }
    console.error("Failed to reset balance:", response.statusText);
    return false;
  } catch (error) {
    console.error("Error resetting balance:", error);
    return false;
  }
};

// Usage
await resetUserBalance(100, "user-id-here");
```

## Practical Examples

### Get User ID and Modify Balance

```javascript
const modifyCurrentUserBalance = async (tokens) => {
  try {
    // First, get current user information
    const userInfo = await paywall.getUser();
    const userId = userInfo.user.id;
    const paywallId = 100; // Replace with your paywall ID

    console.log("Current user:", userId);
    console.log("Current balances:", userInfo.balances);

    // Modify the balance
    const success = await setUserBalance(paywallId, userId, tokens);

    if (success) {
      // Refresh user data to see updated balance
      const updatedUserInfo = await paywall.getUser();
      console.log("Updated balances:", updatedUserInfo.balances);
    }

    return success;
  } catch (error) {
    console.error("Error modifying balance:", error);
    return false;
  }
};

// Usage
await modifyCurrentUserBalance(2500);
```
