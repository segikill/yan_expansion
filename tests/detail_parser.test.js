(function runDetailParserTest() {
  function fixture({ type = "LocalBusiness", name, category, features }) {
    const doc = document.implementation.createHTMLDocument(name);
    doc.head.innerHTML = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": type,
      name,
      category
    })}<\/script>`;
    doc.body.innerHTML = `
      <h1 class="orgpage-header-view__header">${name}</h1>
      <div class="business-categories-view__category">${category}</div>
      <div class="business-features-view">${features}</div>`;
    return doc;
  }

  const valued = (label, value) => `
    <div class="business-features-view__valued">
      <span class="business-features-view__valued-title">${label}:</span>
      <span class="business-features-view__valued-value">${value}</span>
    </div>`;

  const base = globalThis.MapsDetailParser.parseDocument(document, "https://yandex.ru/maps/org/otel_sever/1234567890/");
  const food = globalThis.MapsDetailParser.parseDocument(fixture({
    type: "Restaurant",
    name: "Барбари",
    category: "Ресторан",
    features: valued("Средний счёт", "700–1500 ₽") + valued("Цены", "выше среднего") + valued("Кухня", "грузинская, кавказская")
  }), "https://yandex.ru/maps/org/barbari/1882043913/?tab=features");
  const hotel = globalThis.MapsDetailParser.parseDocument(fixture({
    type: "Hotel",
    name: "Центральный",
    category: "Гостиница",
    features: valued("Количество звёзд", "3") + valued("Тип гостиницы", "бизнес-отель") + valued("Номеров", "85") +
      valued("Цена номера (час)", "3200–10900 ₽") + valued("Время заезда", "14:00") + valued("Дата постройки", "2016") + valued("Время выезда", "12:00")
  }), "https://yandex.ru/maps/org/tsentralny/114820473902/?tab=features");
  const parking = globalThis.MapsDetailParser.parseDocument(fixture({
    name: "Автомобильная парковка",
    category: "Автомобильная парковка",
    features: valued("Парковка", "неохраняемая, открытая, уличная, бесплатная")
  }), "https://yandex.ru/maps/org/avtomobilnaya_parkovka/63212781665/?tab=features");

  const checks = {
    base_org_id: base.org_id === "1234567890",
    base_title: base.title === "\u041e\u0442\u0435\u043b\u044c \u0421\u0435\u0432\u0435\u0440",
    base_phone: base.phones.includes("+7 8152 000-000"),
    base_website: base.websites.includes("https://hotel.example/"),
    base_rating: base.rating === "4,8",
    base_reviews: base.reviews === "123",
    base_adapter: base.category_data.adapter_id === "hotel",
    base_room_count: base.category_data.fields.room_count === 48,
    food_adapter: food.category_data.adapter_id === "food",
    average_bill: food.category_data.fields.average_bill === "700–1500 ₽",
    price_level: food.category_data.fields.price_level === "выше среднего",
    cuisine: food.category_data.fields.cuisine.length === 2,
    hotel_adapter: hotel.category_data.adapter_id === "hotel",
    hotel_stars: hotel.category_data.fields.star_rating === "3",
    hotel_type: hotel.category_data.fields.hotel_type === "бизнес-отель",
    hotel_rooms: hotel.category_data.fields.room_count === 85,
    hotel_price: hotel.category_data.fields.room_price === "3200–10900 ₽",
    hotel_checkin: hotel.category_data.fields.checkin_time === "14:00",
    hotel_year: hotel.category_data.fields.construction_year === 2016,
    hotel_checkout: hotel.category_data.fields.checkout_time === "12:00",
    parking_adapter: parking.category_data.adapter_id === "parking",
    parking_free: parking.category_data.fields.paid === false,
    parking_unguarded: parking.category_data.fields.guarded === false,
    parking_open: parking.category_data.fields.open_air === true,
    parking_street: parking.category_data.fields.street === true,
    whatshere_org_id: globalThis.MapsDetailParser.orgIdFromUrl("https://yandex.ru/maps/36/stavropol/?whatshere%5Buri%5D=ymapsbm1%3A%2F%2Forg%3Foid%3D63212781665") === "63212781665"
  };
  const passed = Object.values(checks).every(Boolean);
  document.documentElement.dataset.testResult = passed ? "PASS" : "FAIL";
  const output = document.createElement("pre");
  output.id = "test-output";
  output.textContent = JSON.stringify({ passed, checks, results: { base, food, hotel, parking } }, null, 2);
  document.body.appendChild(output);
})();
