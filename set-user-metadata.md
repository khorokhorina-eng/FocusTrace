# Set User Metadata

Store custom user data for analytics tracking and user identification purposes.

**Version Requirement:** Available in paywall script version 1.0.1 and later.

**Character Limit:** Metadata has a 100-character limit per field.

## Overview

The `paywall.setUserMetadata()` function allows you to store custom user data
that gets saved to the system when users log in. This is particularly useful
for:

- **Analytics tracking** - Monitor user behavior and conversion paths
- **Attribution tracking** - Track which advertising channels users come from
- **User identification** - Store external user IDs or references
- **Campaign tracking** - Monitor marketing campaign effectiveness

## API Reference

### Method Signature

```typescript
paywall.setUserMetadata(metadata: Record<string, string>): void
```

### Parameters

| Parameter  | Type                    | Description                                |
| ---------- | ----------------------- | ------------------------------------------ |
| `metadata` | `Record<string, string>` | Object containing key-value pairs of metadata to store |

### Constraints

- Each metadata field has a **100-character limit**
- Metadata is stored when the user logs in
- Overwrites any previously set metadata

## Basic Usage

### Simple Tracking

```javascript
// Set advertising channel tracking
paywall.setUserMetadata({
  utm_source: "facebook",
  utm_campaign: "summer_sale_2024",
});
```

### Advanced Attribution

```javascript
// Set comprehensive tracking data
paywall.setUserMetadata({
  fb_pixel: "j463jkj52j5hj347j45lkj7b467jlk6nb7b634n5kl3m",
  user_id: "user_12345",
  referrer: "google.com",
  landing_page: "/pricing",
});
```

## Practical Examples

### Marketing Attribution

```javascript
// Track marketing campaign performance
const trackMarketingAttribution = () => {
  const urlParams = new URLSearchParams(window.location.search);

  const metadata = {};

  // UTM parameters
  if (urlParams.get("utm_source")) {
    metadata.utm_source = urlParams.get("utm_source");
  }
  if (urlParams.get("utm_medium")) {
    metadata.utm_medium = urlParams.get("utm_medium");
  }
  if (urlParams.get("utm_campaign")) {
    metadata.utm_campaign = urlParams.get("utm_campaign");
  }

  // Set metadata before opening paywall
  paywall.setUserMetadata(metadata);
};

// Call before showing paywall
trackMarketingAttribution();
```

### User Journey Tracking

```javascript
// Track user behavior and preferences
const trackUserJourney = () => {
  const metadata = {
    visited_pages: sessionStorage.getItem("visited_pages") || "1",
    time_on_site: Math.floor(
      (Date.now() - sessionStorage.getItem("session_start")) / 1000
    ).toString(),
    device_type: /Mobile|Android|iPhone|iPad/.test(navigator.userAgent)
      ? "mobile"
      : "desktop",
  };

  paywall.setUserMetadata(metadata);
};
```

### External Integration

```javascript
// Link with external systems
const linkExternalSystems = (externalUserId, crmId) => {
  paywall.setUserMetadata({
    external_user_id: externalUserId,
    crm_contact_id: crmId,
    signup_method: "oauth_google",
  });
};

// Usage
linkExternalSystems("ext_user_789", "crm_contact_456");
```

### A/B Testing

```javascript
// Track A/B test variants
const setABTestData = () => {
  const variant = Math.random() > 0.5 ? "A" : "B";

  paywall.setUserMetadata({
    ab_test_variant: variant,
    test_name: "pricing_page_v2",
    test_start_date: new Date().toISOString().split("T")[0], // YYYY-MM-DD
  });

  // Show different pricing based on variant
  if (variant === "A") {
    showOriginalPricing();
  } else {
    showNewPricing();
  }
};
```

## Advanced Usage

### React Hook for Metadata

```javascript
import { useEffect } from "react";

const usePaywallMetadata = (metadata) => {
  useEffect(() => {
    if (metadata && Object.keys(metadata).length > 0) {
      // Validate metadata
      const validMetadata = {};

      Object.entries(metadata).forEach(([key, value]) => {
        if (typeof value === "string" && value.length <= 100) {
          validMetadata[key] = value;
        } else {
          console.warn(
            `Invalid metadata for key ${key}: must be string with max 100 characters`
          );
        }
      });

      if (Object.keys(validMetadata).length > 0) {
        paywall.setUserMetadata(validMetadata);
      }
    }
  }, [metadata]);
};

// Usage in component
const MyComponent = () => {
  const userMetadata = {
    user_type: "trial_user",
    signup_source: "landing_page",
    plan_interest: "pro",
  };

  usePaywallMetadata(userMetadata);

  return (
    <div>
      <button onClick={() => paywall.open()}>Subscribe Now</button>
    </div>
  );
};
```

## Common Use Cases

### 1. Facebook Pixel Integration

```javascript
// Track Facebook advertising attribution
paywall.setUserMetadata({
  fb_pixel: "1234567890123456",
  fb_campaign_id: "campaign_789",
  fb_ad_set_id: "adset_456",
});
```

### 2. Google Analytics Integration

```javascript
// Track Google Analytics data
paywall.setUserMetadata({
  ga_client_id: "GA1.2.1234567890.1234567890",
  ga_session_id: "1234567890.1234567890",
  ga_user_id: "user_12345",
});
```

### 3. Custom CRM Integration

```javascript
// Link with CRM systems
paywall.setUserMetadata({
  salesforce_lead_id: "lead_abc123",
  lead_score: "85",
  lead_source: "website_contact_form",
});
```

### 4. Product Analytics

```javascript
// Track product usage patterns
paywall.setUserMetadata({
  feature_used: "advanced_dashboard",
  usage_frequency: "daily",
  plan_tier_interest: "enterprise",
});
```

## Best Practices

### 1. Set Before Authentication

```javascript
// Always set metadata before user logs in
paywall.setUserMetadata({
  source: "pricing_page",
  plan_viewed: "premium",
});

// Then open paywall
await paywall.open();
```

### 2. Keep Values Short

```javascript
// Good: concise values
paywall.setUserMetadata({
  source: "fb",
  campaign: "sale24",
  user_type: "new",
});

// Avoid: long values that might exceed 100 characters
// paywall.setUserMetadata({
//   description: "Very long description that exceeds the character limit..."
// });
```

### 3. Use Consistent Naming

```javascript
// Use consistent naming conventions
const METADATA_KEYS = {
  UTM_SOURCE: "utm_source",
  UTM_CAMPAIGN: "utm_campaign",
  USER_SEGMENT: "user_segment",
  REFERRER: "referrer",
};

paywall.setUserMetadata({
  [METADATA_KEYS.UTM_SOURCE]: "google",
  [METADATA_KEYS.USER_SEGMENT]: "trial",
});
```

### 4. Handle Errors Gracefully

```javascript
const safeSetMetadata = (metadata) => {
  try {
    // Validate before setting
    const validatedMetadata = Object.fromEntries(
      Object.entries(metadata).filter(
        ([key, value]) => typeof value === "string" && value.length <= 100
      )
    );

    if (Object.keys(validatedMetadata).length > 0) {
      paywall.setUserMetadata(validatedMetadata);
    }
  } catch (error) {
    console.error("Failed to set metadata:", error);
  }
};
```
