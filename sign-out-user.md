# Sign Out User

Sign out a user from the paywall and clear their authentication session.

## Overview

The `paywall.signOut()` function logs out the current user from the paywall
system, clearing their authentication session and any stored user data.

**Key Features:**

- **Session clearing** - Removes user authentication and session data
- **State reset** - Resets paywall to unauthenticated state

## API Reference

### Method Signature

```typescript
paywall.signOut(): void
```

### Return Value

This method does not return a value. It performs the sign-out action
immediately.

## Basic Usage

### Simple Sign Out

```javascript
// Sign out the current user
paywall.signOut();

console.log("User has been signed out");
```

### Sign Out with UI Update

```javascript
const handleSignOut = () => {
  // Sign out the user
  paywall.signOut();

  // Update UI to reflect signed-out state
  updateUserInterface();
  showSignInButton();
  hideUserProfile();
};
```

## Practical Examples

### React Component with Sign Out

```javascript
import { useState, useEffect } from "react";

function UserMenu() {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    // Check if user is authenticated on component mount
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      const userInfo = await paywall.getUser();
      setUser(userInfo.user);
      setIsAuthenticated(true);
    } catch (error) {
      setUser(null);
      setIsAuthenticated(false);
    }
  };

  const handleSignOut = () => {
    // Sign out the user
    paywall.signOut();

    // Update local state
    setUser(null);
    setIsAuthenticated(false);

    // Optional: Show confirmation message
    showMessage("You have been signed out successfully");
  };

  const handleSignIn = async () => {
    try {
      await paywall.open({ resolveEvent: "signed-in" });
      // Refresh user data after sign in
      await checkAuthStatus();
    } catch (error) {
      console.log("Sign in was canceled");
    }
  };

  if (!isAuthenticated) {
    return <button onClick={handleSignIn}>Sign In</button>;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <img
          src={user.avatar}
          alt="Avatar"
          style={{ width: "32px", height: "32px", borderRadius: "50%" }}
        />
        <span>{user.name}</span>
        <button onClick={handleSignOut}>Sign Out</button>
      </div>
    </div>
  );
}
```

### Sign Out with Event Listeners

```javascript
// Listen for authentication status changes
window.addEventListener("message", function (event) {
  if (
    event.data?.type === "state" &&
    [
      "https://onlineapp.pro",
      "https://onlineapp.live",
      "https://onlineapp.stream",
    ].includes(event.origin)
  ) {
    if (event.data.auth_status === "signed-out") {
      console.log("User signed out via event");
      handleUserSignedOut();
    }
  }
});

const handleUserSignedOut = () => {
  // Clear any cached user data
  localStorage.removeItem("user_preferences");
  sessionStorage.clear();

  // Update UI
  document.getElementById("user-menu").style.display = "none";
  document.getElementById("sign-in-button").style.display = "block";

  // Redirect to public page if needed
  if (window.location.pathname.includes("/dashboard")) {
    window.location.href = "/";
  }
};

// Manual sign out function
const signOutUser = () => {
  paywall.signOut();
  // The event listener above will handle the UI updates
};
```

### Sign Out with Confirmation

```javascript
const signOutWithConfirmation = () => {
  // Show confirmation dialog
  const confirmed = confirm("Are you sure you want to sign out?");

  if (confirmed) {
    // Perform sign out
    paywall.signOut();

    // Show success message
    showNotification("You have been signed out successfully");

    // Optional: Redirect to home page
    setTimeout(() => {
      window.location.href = "/";
    }, 1000);
  }
};

// Usage in HTML
// <button onclick="signOutWithConfirmation()">Sign Out</button>
```
