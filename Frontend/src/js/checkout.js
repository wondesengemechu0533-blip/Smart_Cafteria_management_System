import api from "./api.js";
import { validateName, validatePhone, validateRequired } from "./utils/validators.js";

// Check authentication before loading checkout
const authToken = localStorage.getItem("auth_token");
if (!authToken && localStorage.getItem("isLoggedIn") !== "true") {
    alert("Please log in to place an order.");
    window.location.href = "../common/login.html";
}

document.addEventListener("DOMContentLoaded", () => {

    const CART_KEY = "smart_cafeteria_cart";

    const checkoutItemsContainer =
        document.getElementById("checkout-items-list");

    const subtotalElement =
        document.getElementById("checkout-subtotal");

    const serviceFeeElement =
        document.getElementById("checkout-service-fee");

    const totalElement =
        document.getElementById("checkout-total");

    const checkoutForm =
        document.getElementById("checkout-form");

    const orderTypeRadios =
        document.querySelectorAll('input[name="orderType"]');

    const tableNumberGroup =
        document.getElementById("table-number-group");

    const tableNumberInput =
        document.getElementById("table-number");

    const deliveryInfoGroup =
        document.getElementById("delivery-info-group");

    const deliveryFeeRow =
        document.getElementById("checkout-delivery-fee-row");

    const deliveryFeeElement =
        document.getElementById("checkout-delivery-fee");

    const paymentCards =
        document.querySelectorAll(".payment-card");

    const radioCards =
        document.querySelectorAll(".radio-card");

    const SERVICE_FEE_ETB = 20;
    let DELIVERY_FEE_ETB = 30;
    let DELIVERY_ENABLED = true;

    async function loadPublicSettings() {
        try {
            const settingsRes = await api.get("/settings/public");
            const settings = settingsRes.settings || settingsRes || {};
            if (typeof settings.deliveryFee === "number") {
                DELIVERY_FEE_ETB = settings.deliveryFee;
            }
            DELIVERY_ENABLED = settings.deliveryEnabled !== false;
        } catch (error) {
            console.warn("Could not load public settings:", error.message);
        }
    }

    function getSelectedOrderType() {
        const radio = document.querySelector('input[name="orderType"]:checked');
        return radio ? radio.value : "dine-in";
    }

    function updateDeliveryUI() {
        const isDelivery = getSelectedOrderType() === "delivery";
        if (deliveryInfoGroup) {
            deliveryInfoGroup.style.display = isDelivery ? "block" : "none";
        }
        if (deliveryFeeRow) {
            deliveryFeeRow.style.display = isDelivery ? "flex" : "none";
        }
        if (deliveryFeeElement) {
            deliveryFeeElement.textContent = (isDelivery ? DELIVERY_FEE_ETB : 0).toFixed(2);
        }
        renderOrderReview();
    }


    function getCart() {

        try {

            const savedCart =
                localStorage.getItem(CART_KEY);

            if (!savedCart) {
                return [];
            }

            const cart =
                JSON.parse(savedCart);

            return Array.isArray(cart)
                ? cart
                : [];

        } catch (error) {

            console.error(
                "Error reading cart:",
                error
            );

            return [];
        }
    }


    function renderOrderReview() {

        const cart = getCart();

        console.log(
            "Checkout cart:",
            cart
        );


        if (!cart.length) {

            alert(
                "Your cart is empty! Returning to menu."
            );

            window.location.href =
                "menu.html";

            return;
        }


        let itemsHTML = "";
        let subtotal = 0;


        cart.forEach((item) => {

            const itemPrice =
                Number(item.price) || 0;

            const quantity =
                Number(item.quantity) || 1;

            const itemTotal =
                itemPrice * quantity;

            subtotal += itemTotal;


            itemsHTML += `
                <div
                    class="checkout-item-row"
                    style="
                        display:flex;
                        justify-content:space-between;
                        margin-bottom:10px;
                        font-size:0.9rem;
                    "
                >

                    <span>
                        <strong>
                            ${quantity}x
                        </strong>

                        ${escapeHTML(item.name)}
                    </span>

                    <span>
                        <strong>
                            ${itemTotal.toFixed(2)}
                        </strong>
                        ETB
                    </span>

                </div>
            `;

        });


        if (checkoutItemsContainer) {

            checkoutItemsContainer.innerHTML =
                itemsHTML;
        }


        const isDelivery =
            getSelectedOrderType() === "delivery";

        const deliveryFee =
            isDelivery ? DELIVERY_FEE_ETB : 0;

        const total =
            subtotal + SERVICE_FEE_ETB + deliveryFee;


        if (subtotalElement) {

            subtotalElement.textContent =
                subtotal.toFixed(2);
        }


        if (serviceFeeElement) {

            serviceFeeElement.textContent =
                SERVICE_FEE_ETB.toFixed(2);
        }


        if (deliveryFeeElement) {

            deliveryFeeElement.textContent =
                deliveryFee.toFixed(2);
        }


        if (deliveryFeeRow) {

            deliveryFeeRow.style.display =
                isDelivery ? "flex" : "none";
        }


        if (totalElement) {

            totalElement.textContent =
                total.toFixed(2);
        }

    }


    function escapeHTML(value) {

        const div =
            document.createElement("div");

        div.textContent =
            value || "";

        return div.innerHTML;
    }


    orderTypeRadios.forEach((radio) => {

        radio.addEventListener(
            "change",
            async (event) => {

                radioCards.forEach((card) => {
                    card.classList.remove("active");
                });


                const selectedCard =
                    event.target.closest(".radio-card");


                if (selectedCard) {

                    selectedCard.classList.add(
                        "active"
                    );
                }


                if (
                    event.target.value ===
                    "dine-in"
                ) {

                    if (tableNumberGroup) {
                        tableNumberGroup.style.display =
                            "block";
                    }

                    if (tableNumberInput) {
                        tableNumberInput.required =
                            true;
                    }

                } else {

                    if (tableNumberGroup) {
                        tableNumberGroup.style.display =
                            "none";
                    }

                    if (tableNumberInput) {

                        tableNumberInput.required =
                            false;

                        tableNumberInput.value =
                            "";
                    }
                }

                if (
                    event.target.value ===
                    "delivery"
                ) {

                    if (deliveryInfoGroup) {
                        deliveryInfoGroup.style.display =
                            "block";
                    }

                } else {

                    if (deliveryInfoGroup) {
                        deliveryInfoGroup.style.display =
                            "none";
                    }
                }

                updateDeliveryUI();

            }
        );

    });


    const paymentRadios =
        document.querySelectorAll(
            'input[name="paymentMethod"]'
        );


    paymentRadios.forEach((radio) => {

        radio.addEventListener(
            "change",
            async (event) => {

                paymentCards.forEach((card) => {
                    card.classList.remove("active");
                });


                const selectedCard =
                    event.target.closest(
                        ".payment-card"
                    );


                if (selectedCard) {

                    selectedCard.classList.add(
                        "active"
                    );
                }

                // Show Chapa test-mode instructions only when Chapa is selected.
                const chapaTestInfo =
                    document.getElementById(
                        "chapa-test-info"
                    );

                if (chapaTestInfo) {

                    chapaTestInfo.style.display =
                        event.target.value === "CHAPA"
                            ? "block"
                            : "none";
                }

            }
        );

    });


    const placeOrderButton =
        document.getElementById("place-order-btn");

    const mobileOrderButton =
        document.querySelector(".mobile-only-btn");

    function requestCheckoutSubmit() {

        if (checkoutForm) {

            if (typeof checkoutForm.requestSubmit === "function") {

                checkoutForm.requestSubmit();

            } else {

                checkoutForm.dispatchEvent(
                    new Event("submit", { cancelable: true })
                );
            }
        }
    }

    [placeOrderButton, mobileOrderButton].forEach((btn) => {

        if (btn) {

            btn.addEventListener("click", function (event) {

                event.preventDefault();

                requestCheckoutSubmit();
            });
        }
    });


    if (checkoutForm) {

        checkoutForm.addEventListener(
            "submit",
            async (event) => {

                event.preventDefault();


                const cart =
                    getCart();


                if (!cart.length) {

                    alert(
                        "Your cart is empty."
                    );

                    window.location.href =
                        "menu.html";

                    return;
                }


                const selectedOrderType =
                    document.querySelector(
                        'input[name="orderType"]:checked'
                    );


                const selectedPaymentMethod =
                    document.querySelector(
                        'input[name="paymentMethod"]:checked'
                    );


                if (!selectedOrderType) {

                    alert(
                        "Please select an order type."
                    );

                    return;
                }


                if (!selectedPaymentMethod) {

                    alert(
                        "Please select a payment method."
                    );

                    return;
                }


                const orderType =
                    selectedOrderType.value;


                const isDelivery =
                    orderType === "delivery";


                const tableNumber =
                    orderType === "dine-in"
                        ? (
                            tableNumberInput
                                ? tableNumberInput.value.trim()
                                : ""
                        )
                        : isDelivery
                            ? "N/A (Delivery)"
                            : "N/A (Takeaway)";


                if (
                    orderType === "dine-in" &&
                    !tableNumber
                ) {

                    alert(
                        "Please enter your table number."
                    );

                    if (tableNumberInput) {
                        tableNumberInput.focus();
                    }

                    return;
                }


                const customerNameElement =
                    document.getElementById(
                        "customer-name"
                    );


                const customerPhoneElement =
                    document.getElementById(
                        "customer-phone"
                    );


                const customerName =
                    customerNameElement
                        ? customerNameElement.value.trim()
                        : "";


                const customerPhone =
                    customerPhoneElement
                        ? customerPhoneElement.value.trim()
                        : "";

                // Validate name
                const nameValidation = validateName(customerName);
                if (!nameValidation.valid) {
                    alert(nameValidation.error);
                    if (customerNameElement) customerNameElement.focus();
                    return;
                }

                // Validate phone
                const phoneValidation = validatePhone(customerPhone);
                if (!phoneValidation.valid) {
                    alert(phoneValidation.error);
                    if (customerPhoneElement) customerPhoneElement.focus();
                    return;
                }


                let deliveryInfo = null;

                if (isDelivery) {

                    const deliverySubCityElement =
                        document.getElementById("delivery-subcity");

                    const deliveryHouseNumberElement =
                        document.getElementById("delivery-house-number");

                    const deliveryLocationElement =
                        document.getElementById("delivery-location");

                    const deliverySubCity =
                        deliverySubCityElement
                            ? deliverySubCityElement.value.trim()
                            : "";

                    const deliveryHouseNumber =
                        deliveryHouseNumberElement
                            ? deliveryHouseNumberElement.value.trim()
                            : "";

                    const deliveryLocation =
                        deliveryLocationElement
                            ? deliveryLocationElement.value.trim()
                            : "";

                    if (!deliverySubCity) {
                        alert("Please select your area / kebele for delivery.");
                        if (deliverySubCityElement) deliverySubCityElement.focus();
                        return;
                    }

                    if (!deliveryHouseNumber) {
                        alert("Please enter your house number.");
                        if (deliveryHouseNumberElement) deliveryHouseNumberElement.focus();
                        return;
                    }

                    if (!deliveryLocation) {
                        alert("Please enter your street / area name.");
                        if (deliveryLocationElement) deliveryLocationElement.focus();
                        return;
                    }

                    deliveryInfo = {
                        subCity: deliverySubCity,
                        location: "House Number: " + deliveryHouseNumber + ", " + deliveryLocation,
                        phone: customerPhone || ""
                    };
                }


                const paymentMethod =
                    selectedPaymentMethod.value;


                const subtotal =
                    cart.reduce(
                        (sum, item) => {

                            const price =
                                Number(item.price) || 0;

                            const quantity =
                                Number(item.quantity) || 0;

                            return (
                                sum +
                                price * quantity
                            );

                        },
                        0
                    );


                const totalAmount =
                    subtotal + SERVICE_FEE_ETB + (isDelivery ? DELIVERY_FEE_ETB : 0);

                // Map cart items to backend expected format
                const orderItems = cart.map(item => ({
                    id: item.menuItemId || item.id,
                    name: item.name,
                    quantity: Number(item.quantity) || 1,
                    price: Number(item.price) || 0
                }));

                const orderId =
                    "ET-" +
                    Math.floor(
                        1000 +
                        Math.random() * 9000
                    );


                const newOrder = {

                    orderId: orderId,

                    orderDate:
                        new Date().toLocaleString(),

                    orderType:
                        orderType,

                    tableNumber:
                        tableNumber,

                    customerName:
                        customerName,

                    customerPhone:
                        customerPhone,

                    paymentMethod:
                        paymentMethod,

                    items:
                        orderItems,

                    subtotal:
                        subtotal,

                    serviceFee:
                        SERVICE_FEE_ETB,

                    deliveryFee:
                        isDelivery ? DELIVERY_FEE_ETB : 0,

                    deliveryInfo:
                        deliveryInfo,

                    totalAmount:
                        totalAmount,

                    status:
                        "pending"
                };


                try {
                    const orderResponse = await api.post("/orders", newOrder);
                    const createdOrderId = orderResponse.order?.orderId || orderId;
                    
                    // Try real payment first, fallback to simulation if not configured
                    let checkoutUrl = null;
                    let paymentSuccess = false;
                    
                    const paymentEndpoint = "/payments/chapa/initialize";
                    
                    try {
                        const paymentResponse = await api.post(paymentEndpoint, {
                            orderId: createdOrderId,
                            returnUrl: `${window.location.origin}/src/pages/customer/order-tracking.html?orderId=${encodeURIComponent(createdOrderId)}`
                        });
                        
                        checkoutUrl = paymentResponse.data?.checkoutUrl || paymentResponse.checkoutUrl;

                        if (!checkoutUrl) {
                            throw new Error("Provider did not return a checkout URL");
                        }

                        // Remember the Chapa transaction reference so the
                        // order-tracking page can verify payment after the
                        // user completes checkout on Chapa's hosted page.
                        if (paymentMethod === "CHAPA") {
                            const txRef =
                                paymentResponse.transactionReference ||
                                paymentResponse.data?.transactionReference ||
                                paymentResponse.data?.tx_ref ||
                                "";
                            if (txRef) {
                                try {
                                    localStorage.setItem(
                                        "chapa_pending_payment",
                                        JSON.stringify({
                                            orderId: createdOrderId,
                                            txRef,
                                            paymentId:
                                                paymentResponse.data?.paymentId ||
                                                paymentResponse.data?.id ||
                                                ""
                                        })
                                    );
                                } catch (e) {
                                    console.warn("Could not save pending Chapa payment:", e);
                                }
                            }
                        }
                    } catch (paymentError) {
                        console.log('Real payment failed, trying simulation:', paymentError.message);
                        // Fallback to simulation payment with checkout URL
                        try {
                            const simResponse = await api.post("/payments/simulate", {
                                orderId: createdOrderId,
                                method: paymentMethod,
                                phone: customerPhone,
                                simulationMode: 'checkout',
                                returnUrl: `${window.location.origin}/src/pages/customer/order-tracking.html?orderId=${encodeURIComponent(createdOrderId)}`
                            });
                            
                            checkoutUrl = simResponse.data?.checkoutUrl || simResponse.checkoutUrl;
                        } catch (simError) {
                            console.error('Simulation payment also failed:', simError);
                            throw new Error('Payment initialization failed. Please try again.');
                        }
                    }
                    
                    if (!checkoutUrl) {
                        throw new Error(`${paymentMethod} did not return a checkout URL.`);
                    }

                    // Persist the order locally so the receipt / order-tracking
                    // page can render it immediately after payment, even when
                    // no backend order-history page is open.
                    const orderRecord = {
                        ...newOrder,
                        orderId: createdOrderId,
                        paymentMethod: paymentMethod,
                        paymentStatus: "PENDING",
                        status: "pending"
                    };
                    try {
                        localStorage.setItem("latestOrder", JSON.stringify(orderRecord));
                        let history = JSON.parse(localStorage.getItem("orderHistory")) || [];
                        let exists = false;
                        history = history.map((o) => {
                            if ((o.orderId || o.id) === createdOrderId) {
                                exists = true;
                                return orderRecord;
                            }
                            return o;
                        });
                        if (!exists) {
                            history.unshift(orderRecord);
                        }
                        localStorage.setItem("orderHistory", JSON.stringify(history));
                    } catch (e) {
                        console.warn("Could not save order locally:", e);
                    }

                    localStorage.removeItem(CART_KEY);
                    localStorage.removeItem("checkoutCart");
                    window.dispatchEvent(new CustomEvent("cart:updated"));
                    window.location.href = checkoutUrl;
                } catch (error) {
                    alert(error.message || "Unable to start payment.");
                }

            }
        );

    }


    renderOrderReview();

    loadPublicSettings().then(() => {

        if (!DELIVERY_ENABLED) {

            const deliveryCard =
                document.getElementById("delivery-radio-card");

            if (deliveryCard) {

                deliveryCard.style.display = "none";
            }
        }

        updateDeliveryUI();
    });

});