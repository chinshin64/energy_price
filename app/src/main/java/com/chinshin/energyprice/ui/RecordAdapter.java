package com.chinshin.energyprice.ui;

import android.view.LayoutInflater;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.chinshin.energyprice.data.CaptureRecord;
import com.chinshin.energyprice.databinding.ItemCaptureBinding;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class RecordAdapter extends RecyclerView.Adapter<RecordAdapter.Holder> {
    public interface SelectionListener {
        void onSelectionChanged(int count);
    }

    private final List<CaptureRecord> records = new ArrayList<>();
    private final Set<Long> selectedIds = new HashSet<>();
    private final SelectionListener listener;
    private boolean selectionMode;

    public RecordAdapter(SelectionListener listener) {
        this.listener = listener;
        setHasStableIds(true);
    }

    public void submit(List<CaptureRecord> data) {
        records.clear();
        records.addAll(data);
        Set<Long> validIds = new HashSet<>();
        for (CaptureRecord record : data) validIds.add(record.id);
        selectedIds.retainAll(validIds);
        notifyDataSetChanged();
        notifySelection();
    }

    public boolean isSelectionMode() {
        return selectionMode;
    }

    public void exitSelectionMode() {
        selectionMode = false;
        selectedIds.clear();
        notifyDataSetChanged();
        notifySelection();
    }

    public void selectAll() {
        selectionMode = true;
        selectedIds.clear();
        for (CaptureRecord record : records) selectedIds.add(record.id);
        notifyDataSetChanged();
        notifySelection();
    }

    public List<Long> selectedIds() {
        return new ArrayList<>(selectedIds);
    }

    @Override
    public long getItemId(int position) {
        return records.get(position).id;
    }

    @NonNull
    @Override
    public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        return new Holder(ItemCaptureBinding.inflate(LayoutInflater.from(parent.getContext()), parent, false));
    }

    @Override
    public void onBindViewHolder(@NonNull Holder holder, int position) {
        holder.bind(records.get(position));
    }

    @Override
    public int getItemCount() {
        return records.size();
    }

    private void toggleSelection(CaptureRecord record) {
        selectionMode = true;
        if (!selectedIds.add(record.id)) selectedIds.remove(record.id);
        if (selectedIds.isEmpty()) selectionMode = false;
        notifyDataSetChanged();
        notifySelection();
    }

    private void notifySelection() {
        listener.onSelectionChanged(selectedIds.size());
    }

    final class Holder extends RecyclerView.ViewHolder {
        private final ItemCaptureBinding binding;

        Holder(ItemCaptureBinding binding) {
            super(binding.getRoot());
            this.binding = binding;
        }

        void bind(CaptureRecord record) {
            binding.stationName.setText(record.stationName);
            binding.gradeBadge.setText(record.gradeCode + "#");
            binding.priceLine.setText(StationDisplayFormatter.priceLine(record));
            binding.discountLine.setText(StationDisplayFormatter.discountLine(record));
            binding.providerLine.setText(StationDisplayFormatter.providerLine(record));
            binding.timeLine.setText(StationDisplayFormatter.timeLine(record));
            binding.cardRoot.setActivated(selectedIds.contains(record.id));
            binding.getRoot().setOnLongClickListener(v -> {
                toggleSelection(record);
                return true;
            });
            binding.getRoot().setOnClickListener(v -> {
                if (selectionMode) toggleSelection(record);
            });
        }
    }
}
