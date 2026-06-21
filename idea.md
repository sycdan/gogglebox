# Family Media Portal — Technical Specification

## 1. Project Overview

The goal is to build a **LAN-hosted family media portal** that integrates with a Jellyfin server and provides:

- A **master login** for household access  
- A **“Who’s watching?”** selector that supports **multiple simultaneous viewers**  
- Automatic **watch tracking** for all selected viewers  
- **Group-based recommendations** (content none of the selected viewers have seen)  
- A clean, simple web interface accessible at a LAN URL (e.g., `http://gogglebox.local`)

This document defines the architecture, requirements, data model, API interactions, and implementation phases.

---

## 2. Functional Requirements

### 2.1 Authentication

- Single household login (shared password or per-adult accounts)  
- After login, user is taken to a **multi-select viewer screen**

### 2.2 Viewer Selection

- Display all family members (mapped to Jellyfin user IDs)  
- Allow selecting **one or more** viewers  
- Persist the selected group for the session

### 2.3 Browsing & Playback

- Browse movies and shows from Jellyfin  
- Filter by:
  - Movies
  - Shows
  - Kids content
  - Genre
- Start playback either:
  - In Jellyfin’s native web player (redirect)
  - Or via embedded player (optional)

### 2.4 Watch Tracking

- When playback finishes (or user clicks “Mark as watched”):
  - Mark the item as watched for **all selected viewers**
- Allow manual override per viewer

### 2.5 Group Recommendations

For a selected group:

- Recommend movies **none** of the group has watched  
- Recommend shows **none** of the group has started  
- Optional: genre filters, “family night” curated lists  

---

## 3. Non-Functional Requirements

- **LAN-first** deployment  
- **Low maintenance**  
- **Secure** (session cookies, optional HTTPS)  
- **Responsive UI**  
- **Configurable** (Jellyfin URL, API key, family members)  

---

## 4. System Architecture

### 4.1 Components

#### Jellyfin Server (existing)

- Hosts media  
- Provides metadata  
- Tracks watch history  
- Exposes REST API  

#### Family Portal Backend (new)

- Handles:
  - Authentication
  - Viewer group management
  - Jellyfin API integration
  - Group recommendation logic
- Possible stacks:
  - Node.js + Express
  - Python + FastAPI
  - Go + Fiber

#### Family Portal Frontend (new)

- Web UI for:
  - Login
  - Viewer selection
  - Browsing
  - Recommendations
- Possible stacks:
  - React
  - Vue
  - Svelte
  - Or server-rendered templates

---

## 5. Data Model (Portal Side)

### FamilyMember

| Field          | Type   | Description              |
|----------------|--------|--------------------------|
| id             | string | Portal-side ID           |
| name           | string | Display name             |
| jellyfinUserId | string | Maps to Jellyfin user    |
| avatarUrl      | string | Optional avatar URL      |

### ViewerGroup (session)

| Field      | Type     | Description                    |
|------------|----------|--------------------------------|
| id         | string   | Session ID                     |
| memberIds  | array    | Selected FamilyMember IDs      |
| createdAt  | datetime | Session creation time          |

### PortalUser

| Field        | Type   | Description        |
|--------------|--------|--------------------|
| id           | string | User ID            |
| username     | string | Login name         |
| passwordHash | string | Secure hash        |

No media metadata is stored in the portal; it is fetched from Jellyfin.

---

## 6. Jellyfin API Integration

### 6.1 Required Endpoints

#### List items

`GET /Items`

Used to fetch movies/shows with filters (e.g., by type, genre).

#### List watched items for a user

`GET /Users/{userId}/Items?Filters=IsPlayed`

Used to build each user’s watched set.

#### Mark item as played

`POST /Users/{userId}/PlayedItems/{itemId}`

Called for each selected viewer when marking an item as watched.

#### Mark item as unplayed

`DELETE /Users/{userId}/PlayedItems/{itemId}`

For manual corrections.

#### Optional: Jellyfin recommendations

`GET /Items/Recommendations`

Can be used as a candidate pool for group recommendations.

---

## 7. Group Recommendation Logic

### Inputs

- `groupMemberIds[]` (portal FamilyMember IDs)

### Steps

1. Map `groupMemberIds[]` → Jellyfin user IDs.  
2. For each Jellyfin user:
   - Fetch watched items via `GET /Users/{userId}/Items?Filters=IsPlayed`.
3. Build the **union** of all watched item IDs across the group.  
4. Fetch candidate items:
   - Either:
     - All movies/shows from `/Items` with filters, or
     - Jellyfin recommendations for a “primary” user.
5. Filter out any item whose ID is in the union.  
6. Sort remaining items by:
   - Rating
   - Popularity
   - Release date
   - Or Jellyfin’s recommendation score (if available).  

### Output

- A list of items that **none** of the selected viewers have watched.

---

## 8. Frontend UX Flow

### 8.1 Login Screen

- Simple username/password form.  
- On success:
  - Create an authenticated session.
  - Redirect to Viewer Selection.

### 8.2 Viewer Selection (“Who’s watching?”)

- Display all `FamilyMember` profiles as cards (with optional avatars).  
- Allow multi-select (toggle behavior).  
- “Continue” button:
  - Sends selected member IDs to backend.
  - Backend creates a `ViewerGroup` and returns its ID.
  - Store `ViewerGroup` ID in session/local state.

### 8.3 Home Screen (Group Context)

- Uses current `ViewerGroup` ID.  
- Sections might include:
  - “Because none of you have seen this” (group recommendations).
  - “New for this group” (recently added, unwatched by group).
  - “Continue watching (any of you)” (optional, union of in-progress items).  
- Each item card:
  - Poster, title, year, runtime, rating.
  - “Play” button.
  - “Mark as watched for group” button (if not already watched by all).

### 8.4 Playback

Two implementation options:

#### Option A: Redirect to Jellyfin Web UI

- Clicking “Play” opens Jellyfin’s web player for that item (new tab or same tab).  
- After watching, user returns to portal and clicks “Mark as watched for group”.  
- Simpler, no custom player needed.

#### Option B: Embedded Player

- Use Jellyfin’s streaming URLs in a custom HTML5 player.  
- On playback end event:
  - Automatically call backend to mark item as watched for all viewers in the group.  
- More complex but smoother UX.

---

## 9. Security & Deployment

### 9.1 Deployment

- Recommended: Docker-based deployment.  
- Components:
  - `jellyfin` container (if not already running elsewhere).
  - `family-portal-backend` container.
  - `family-portal-frontend` container (or served by backend).  

### 9.2 Networking

- LAN-only by default:
  - Expose portal at `http://family-media.local` (via local DNS or hosts file).  
- Optional external access:
  - Reverse proxy (Caddy, Nginx, Traefik).
  - HTTPS via Let’s Encrypt.
  - Additional auth if exposed to the internet.

### 9.3 Authentication

- Use session cookies or short-lived JWTs.  
- Store only minimal user data in the session:
  - Portal user ID
  - Current ViewerGroup ID  
- Consider CSRF protection if using cookies.

---

## 10. Implementation Phases

### Phase 1 — Foundation

- Set up Jellyfin (if not already running).  
- Create backend skeleton:
  - Basic HTTP server.
  - Config loading (Jellyfin URL, API key, family members).  
- Implement Jellyfin API client wrapper:
  - Functions for listing items, fetching watched items, marking played/unplayed.

### Phase 2 — Core Flows

- Implement portal authentication:
  - Simple username/password, stored securely.  
- Implement FamilyMember configuration:
  - Static config file or small admin UI.  
- Implement ViewerGroup creation and storage (in-memory or lightweight DB).  
- Implement basic browsing:
  - Endpoint to list movies/shows from Jellyfin.  
- Implement “mark watched for group”:
  - Backend endpoint that:
    - Accepts `itemId` and current `ViewerGroup`.
    - Calls Jellyfin `PlayedItems` for each member.

### Phase 3 — Group Recommendations

- Implement backend logic:
  - Fetch watched sets per user.
  - Compute union.
  - Fetch candidate items.
  - Filter and sort.  
- Expose `/groups/{groupId}/recommendations` endpoint.  
- Frontend:
  - “For this group” section on home screen.

### Phase 4 — Polish

- Add avatars and nicer UI for family members.  
- Add filters:
  - Genre
  - Runtime
  - Rating
  - Kids-only mode (based on Jellyfin tags/ratings).  
- Improve error handling and loading states.

### Phase 5 — Advanced

- Implement embedded player with auto-tracking (if desired).  
- Add analytics:
  - Most-watched genres.
  - Time-of-day viewing patterns.  
- Optional:
  - Remote access with secure auth.
  - Integration with external services (Trakt, TMDB).

---

## 11. Deliverables

The implementing agent should provide:

- **Backend service**:
  - Source code.
  - API documentation.
  - Config file for:
    - Jellyfin URL
    - API key
    - Family members.  

- **Frontend web app**:
  - Source code.
  - Build instructions.  

- **Deployment assets**:
  - Dockerfile(s).
  - Docker Compose file (recommended).  

- **Documentation**:
  - Setup guide.
  - Configuration guide.
  - Usage guide (for the family).

---

## 12. Future Enhancements

- Shared “family night” playlists.  
- Per-group watchlists (e.g., “Movies for Mom + Kid1”).  
- Smarter suggestions based on:
  - Overlapping liked genres.
  - Time available (e.g., “under 90 minutes”).  
- Support for multiple media backends (e.g., Plex, Emby) behind a common abstraction.  
- Role-based access (e.g., kids can’t change settings or see certain content).

