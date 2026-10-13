/**
 * Authentication Service
 * File: frontend/src/services/auth.service.js
 */

import api from "../js/api.js";

export class AuthService {

    async login(credentials) {
        const response = await api.post(
            "/auth/login",
            credentials
        );

        const token =
            response?.token ||
            response?.data?.token ||
            response?.accessToken;

        const user =
            response?.user ||
            response?.data?.user ||
            null;

        if (token) {
            api.setToken(token);
        }

        if (user) {
            localStorage.setItem(
                "current_user",
                JSON.stringify(user)
            );
            // Also expose the role/name at the top level for the many parts of
            // the app that read these keys directly (socket.js room-joining,
            // kitchen/customer headers, etc.). This is what allows the kitchen
            // socket client to join the "kitchen" room and receive real-time
            // new-order / status events.
            const role = user.role || "";
            const name = user.name || user.username || user.fullName || user.email || "";
            try {
                localStorage.setItem("role", role);
                localStorage.setItem("userRole", role);
                if (name) {
                    localStorage.setItem("userName", name);
                    localStorage.setItem("name", name);
                }
            } catch (e) {
                console.warn("Could not persist auth keys:", e.message);
            }
        }

        return response;
    }

    async register(userData) {
        return api.post("/auth/register", userData);
    }

    async logout() {
        try {
            await api.post("/auth/logout");
        } catch (error) {
            console.warn(
                "Logout API request failed:",
                error.message
            );
        }

        api.removeToken();
        [
            "current_user",
            "role",
            "userRole",
            "userName",
            "name",
            "isLoggedIn",
            "userProfile",
            "adminLoggedIn",
            "customerLoggedIn",
            "managerLoggedIn",
            "kitchenLoggedIn",
            "cashierLoggedIn",
            "deliveryLoggedIn"
        ].forEach((key) => localStorage.removeItem(key));
    }

    async getProfile() {
        return api.get("/auth/profile");
    }

    async updateProfile(data) {
        const response = await api.put(
            "/auth/profile",
            data
        );

        const user =
            response?.user ||
            response?.data?.user ||
            null;

        if (user) {
            localStorage.setItem(
                "current_user",
                JSON.stringify(user)
            );
        }

        return response;
    }

    async changePassword(data) {
        return api.put(
            "/auth/change-password",
            data
        );
    }

    getCurrentUser() {
        const user = localStorage.getItem("current_user");

        if (!user) {
            return null;
        }

        try {
            return JSON.parse(user);
        } catch {
            return null;
        }
    }

    isAuthenticated() {
        return Boolean(api.getToken());
    }

    hasRole(role) {
        const user = this.getCurrentUser();
        const currentRole = String(user?.role || '').toLowerCase();
        const requestedRole = String(role || '').toLowerCase();
        if (requestedRole === 'foodmaker' || requestedRole === 'kitchen_staff' || requestedRole === 'staff') {
            return currentRole === 'kitchen' || currentRole === 'foodmaker' || currentRole === 'kitchen_staff' || currentRole === 'staff';
        }
        return currentRole === requestedRole;
    }

    isAdmin() {
        return this.hasRole("admin");
    }

    isFoodMaker() {
        return this.hasRole("kitchen");
    }

}

const authService = new AuthService();

export default authService;