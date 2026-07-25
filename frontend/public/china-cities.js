(function loadChinaCityPresets() {
    const presets = [];
    window.CHINA_CITY_PRESETS = presets;
    window.CHINA_CITY_PRESETS_READY = fetch('./china-city-presets.json', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
    })
        .then(response => {
            if (!response.ok) {
                throw new Error(`city presets request failed: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            if (!Array.isArray(data)) {
                throw new Error('city presets response must be an array');
            }
            presets.splice(0, presets.length, ...data);
            return presets;
        })
        .catch(error => {
            console.error('Failed to load city presets:', error);
            return presets;
        });
})();
