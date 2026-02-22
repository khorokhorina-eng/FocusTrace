# Get Offer Info

Get information about the current paywall offer available for user.

**Version Requirement:** Available in paywall script version 2.1.2 and later.

## Overview

The `paywall.getOfferInfo()` method retrieves information about promotional
offers that are configured for the paywall:

- **Discount offers** - Special pricing promotions with percentage discounts
- **Time-limited offers** - Offers with countdown timers and expiration dates
- **Targeted offers** - Offers displayed to specific user segments (new users,
  returning users, etc.)
- **No offer** - When no promotional offer is active

## API Reference

### Method Signature

```typescript
paywall.getOfferInfo(): Promise<OfferInfo | null>
```

### Return Type

```typescript
interface OfferInfo {
  /** Unique identifier of the offer */
  offer_id: number;
  /** Display name of the offer */
  offer_name: string;
  /** Optional description text for the offer */
  offer_description: string;
  /** Type of timer: 'duration' for countdown or 'end_date' for fixed date */
  timer_type: "duration" | "end_date";
  /** Duration in minutes for countdown timer (when timer_type is 'duration') */
  timer_duration: number;
  /** Fixed end date for the offer (when timer_type is 'end_date') */
  end_date: string | null;
  /** Start time of the offer in ISO format (useful for duration-based offers) */
  startTime: string;
  /** Target audience: 'new_users', 'returning_users', or 'all' */
  timer_target: "new_users" | "returning_users" | "all";
  /** Discount percentage (0-100) */
  discount_percentage: number;
  /** Conditions for displaying the offer */
  display_conditions: any | null;
  /** Visual settings for the offer display */
  display_settings: {
    /** Visual theme: 'urgent', 'friendly', 'minimal' */
    theme: string;
    /** Main title text */
    title: string;
    /** Position on screen: 'center', 'top', 'bottom' */
    position: string;
    /** Subtitle text */
    subtitle: string;
    /** Call-to-action button text */
    button_text: string;
  };
  /** Display priority (higher numbers show first) */
  priority: number;
  /** Whether discount is automatically applied */
  auto_apply: boolean;
  /** Whether to show countdown timer */
  show_countdown: boolean;
}
```

## Basic Usage

### Checking Offer Availability

```javascript
try {
  const offerInfo = await paywall.getOfferInfo();

  if (offerInfo === null) {
    console.log("No offer available");
  } else {
    console.log(
      `Offer: ${offerInfo.offer_name} - ${offerInfo.discount_percentage}% off`
    );
    console.log(`Timer type: ${offerInfo.timer_type}`);

    if (offerInfo.timer_type === "duration") {
      console.log(`Duration: ${offerInfo.timer_duration} minutes`);
      console.log(`Started at: ${offerInfo.startTime}`);

      // Calculate exact remaining time
      const startTime = new Date(offerInfo.startTime).getTime();
      const durationMs = offerInfo.timer_duration * 60 * 1000;
      const endTime = startTime + durationMs;
      const remainingMs = endTime - Date.now();

      if (remainingMs > 0) {
        const remainingMinutes = Math.floor(remainingMs / (1000 * 60));
        console.log(`Time remaining: ${remainingMinutes} minutes`);
      } else {
        console.log("Offer has expired");
      }
    } else {
      console.log(`End date: ${offerInfo.end_date}`);
    }
  }
} catch (error) {
  console.error("Failed to get offer info:", error);
}
```

## Practical Examples

### Offer Display Handler

```javascript
const handleOfferDisplay = async () => {
  try {
    const offerInfo = await paywall.getOfferInfo();

    if (offerInfo && offerInfo.discount_percentage > 0) {
      // Show offer banner
      showOfferBanner({
        title: offerInfo.display_settings.title,
        subtitle: offerInfo.display_settings.subtitle,
        discount: offerInfo.discount_percentage,
        buttonText: offerInfo.display_settings.button_text,
        theme: offerInfo.display_settings.theme,
        showCountdown: offerInfo.show_countdown,
        timerDuration: offerInfo.timer_duration,
      });

      // Track offer impression
      trackOfferImpression(offerInfo.offer_id);
    }
  } catch (error) {
    console.error("Error displaying offer:", error);
  }
};
```

### Countdown Timer Implementation

```javascript
const setupOfferCountdown = async () => {
  try {
    const offerInfo = await paywall.getOfferInfo();

    if (offerInfo && offerInfo.show_countdown && offerInfo.timer_type === "duration") {
      const startCountdown = () => {
        // Use startTime for precise calculation instead of current time
        const startTime = new Date(offerInfo.startTime).getTime();
        const durationMs = offerInfo.timer_duration * 60 * 1000;
        const endTime = startTime + durationMs;

        const updateTimer = () => {
          const timeLeft = endTime - Date.now();

          if (timeLeft <= 0) {
            document.getElementById("countdown").textContent = "Offer expired!";
            return;
          }

          const minutes = Math.floor(timeLeft / (1000 * 60));
          const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);

          document.getElementById("countdown").textContent = `${minutes}:${seconds
            .toString()
            .padStart(2, "0")}`;

          setTimeout(updateTimer, 1000);
        };

        updateTimer();
      };

      startCountdown();
    }
  } catch (error) {
    console.error("Error setting up countdown:", error);
  }
};
```

### React Component

```javascript
import { useState, useEffect } from "react";

function OfferBanner() {
  const [offerInfo, setOfferInfo] = useState(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchOfferInfo = async () => {
      try {
        const info = await paywall.getOfferInfo();
        setOfferInfo(info);

        if (info && info.timer_type === "duration") {
          // Calculate remaining time using startTime for accuracy
          const startTime = new Date(info.startTime).getTime();
          const durationMs = info.timer_duration * 60 * 1000;
          const endTime = startTime + durationMs;
          const remainingMs = endTime - Date.now();

          if (remainingMs > 0) {
            setTimeLeft(Math.floor(remainingMs / 1000));
          } else {
            setTimeLeft(0);
          }
        }
      } catch (error) {
        console.error("Failed to fetch offer info:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchOfferInfo();
  }, []);

  useEffect(() => {
    if (timeLeft > 0) {
      const timer = setTimeout(() => {
        setTimeLeft(timeLeft - 1);
      }, 1000);

      return () => clearTimeout(timer);
    }
  }, [timeLeft]);

  if (loading) {
    return <div>Loading offer...</div>;
  }

  if (!offerInfo) {
    return null;
  }

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className={`offer-banner theme-${offerInfo.display_settings.theme}`}>
      <h3>{offerInfo.display_settings.title}</h3>
      <p>{offerInfo.display_settings.subtitle}</p>
      <div className="discount-badge">
        {offerInfo.discount_percentage}% OFF
      </div>

      {offerInfo.show_countdown && timeLeft > 0 && (
        <div className="countdown">Time left: {formatTime(timeLeft)}</div>
      )}

      <button onClick={() => paywall.open()} className="offer-button">
        {offerInfo.display_settings.button_text}
      </button>
    </div>
  );
}
```

## Understanding startTime for Duration Offers

The `startTime` field is crucial for working correctly with `duration` type
offers. It contains the exact time when the offer started in ISO 8601 format.

### Why is startTime necessary?

When working with `timer_type = "duration"`, it's important to know **exactly
when** the offer countdown began in order to:

1. **Calculate precise remaining time** - using `startTime + timer_duration`,
   not the current time
2. **Synchronize timers** across different tabs/devices
3. **Correctly restore state** after page reload

### Remaining Time Calculation Example

```javascript
// ✅ Correct approach using startTime
const calculateRemainingTime = (offerInfo) => {
  if (offerInfo.timer_type !== "duration") return null;

  const startTime = new Date(offerInfo.startTime).getTime();
  const durationMs = offerInfo.timer_duration * 60 * 1000;
  const endTime = startTime + durationMs;
  const remainingMs = endTime - Date.now();

  return Math.max(0, remainingMs);
};

// ❌ Incorrect approach without startTime
const incorrectCalculation = (offerInfo) => {
  // This will give inaccurate results as it doesn't account
  // for when the offer actually started
  return offerInfo.timer_duration * 60 * 1000;
};
```

### Practical Example: Timer Restoration

```javascript
const restoreOfferTimer = async () => {
  const offerInfo = await paywall.getOfferInfo();

  if (offerInfo && offerInfo.timer_type === "duration") {
    const startTime = new Date(offerInfo.startTime).getTime();
    const durationMs = offerInfo.timer_duration * 60 * 1000;
    const endTime = startTime + durationMs;
    const now = Date.now();

    if (now < endTime) {
      const remainingMs = endTime - now;
      console.log(
        `Offer active for ${Math.floor(remainingMs / 1000 / 60)} more minutes`
      );

      // Start timer with correct remaining time
      startCountdownTimer(remainingMs);
    } else {
      console.log("Offer has expired");
      hideOfferBanner();
    }
  }
};
```

## Error Handling

```javascript
const safeGetOfferInfo = async () => {
  try {
    const offerInfo = await paywall.getOfferInfo();
    return offerInfo;
  } catch (error) {
    if (error.message.includes("not initialized")) {
      console.error("Paywall not initialized yet");
    } else if (error.message.includes("version")) {
      console.error("Paywall version too old - upgrade to 2.1.2+");
    } else {
      console.error("Failed to get offer info:", error);
    }

    // Return safe default
    return null;
  }
};
```

## Data Example

```javascript
{
  "offer_id": 76,
  "offer_name": "New users discount",
  "offer_description": "",
  "timer_type": "duration",
  "timer_duration": 720,
  "end_date": null,
  "startTime": "2024-01-15T10:30:00.000Z",
  "timer_target": "new_users",
  "discount_percentage": 25,
  "display_conditions": null,
  "display_settings": {
    "theme": "urgent",
    "title": "Welcome offer",
    "position": "center",
    "subtitle": "Only now",
    "button_text": "Get Discount"
  },
  "priority": 0,
  "auto_apply": false,
  "show_countdown": true
}
```
