package com.datafordidi.mocklocation;

import android.content.Context;

import org.maplibre.android.maps.MapView;

public final class AccessibleMapView extends MapView {
    public AccessibleMapView(Context context) {
        super(context);
    }

    @Override
    public boolean performClick() {
        super.performClick();
        return true;
    }
}
