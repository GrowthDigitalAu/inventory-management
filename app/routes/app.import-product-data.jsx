import { useState, useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Pagination, ProgressBar } from "@shopify/polaris";

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const checkStatus = url.searchParams.get("checkStatus");
    const operationId = url.searchParams.get("operationId");

    // --- POLLING LOGIC ---
    if (checkStatus === "true" && operationId) {
        const response = await admin.graphql(
            `#graphql
            query($id: ID!) {
                node(id: $id) {
                    ... on BulkOperation {
                        id
                        status
                        objectCount
                        url
                    }
                }
            }`,
            { variables: { id: operationId } }
        );

        const data = await response.json();
        const bulkOperation = data.data?.node;

        if (!bulkOperation) {
            return { success: false, status: "NONE", operationId };
        }

        if (bulkOperation.status === "COMPLETED") {
             // Check result file for userErrors
             let bulkErrors = [];
             let successCount = 0;
             
             if (bulkOperation.url) {
                try {
                    const fileResponse = await fetch(bulkOperation.url);
                    const text = await fileResponse.text();
                    const lines = text.split("\n").filter(line => line.trim() !== "");
                    lines.forEach(line => {
                        const result = JSON.parse(line);
                        const userErrors = result.inventorySetQuantities?.userErrors || [];
                        if (userErrors.length > 0) {
                             bulkErrors.push(userErrors[0].message);
                        } else {
                             successCount++;
                        }
                    });
                } catch (e) {
                    console.error("Error parsing bulk result", e);
                }
             } else {
                 successCount = parseInt(bulkOperation.objectCount) || 0;
             }
             // Explicitly return operationId for frontend validation
             return { success: true, status: "COMPLETED", bulkResults: { updated: successCount, errors: bulkErrors }, operationId };

        } else if (bulkOperation.status === "RUNNING" || bulkOperation.status === "CREATED") {
             return { success: true, status: "RUNNING", progress: bulkOperation.objectCount, operationId };
        } else {
             return { success: false, status: bulkOperation.status, operationId };
        }
    }

    // --- INITIAL DATA ---
    const response = await admin.graphql(
        `#graphql
        query getLocations {
            locations(first: 250, includeLegacy: true, includeInactive: true) {
                edges {
                    node {
                        id
                        name
                        isActive
                    }
                }
            }
        }`
    );

    const data = await response.json();
    const locations = data.data?.locations?.edges.map(edge => ({
        id: edge.node.id,
        name: edge.node.name,
        isActive: edge.node.isActive
    })) || [];

    return { locations };
};

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const dataString = formData.get("data");
    const locationId = formData.get("locationId");
    const rows = JSON.parse(dataString);

    const results = {
        total: rows.length,
        updated: 0, 
        errors: [],
        failedRows: [],
        skippedRows: [],
        bulkOperationId: null
    };

    const isAllLocationsMode = locationId === "ALL_LOCATIONS";

    // 1. HELPER: Fetch All Locations
    let allLocations = [];
    if (isAllLocationsMode) {
        const locationsQuery = await admin.graphql(
            `#graphql
            query getLocations {
                locations(first: 250, includeLegacy: true, includeInactive: true) {
                    edges { node { id name } }
                }
            }`
        );
        const locationsResult = await locationsQuery.json();
        allLocations = locationsResult.data?.locations?.edges.map(edge => ({
            id: edge.node.id,
            name: edge.node.name
        })) || [];
    }

    // 2. HELPER: Get Selected Location Name
    let selectedLocationName = null;
    if (!isAllLocationsMode) {
        const locationQuery = await admin.graphql(
            `#graphql
            query getLocation($id: ID!) {
                location(id: $id) { name }
            }`,
            { variables: { id: locationId } }
        );
        const locationResult = await locationQuery.json();
        selectedLocationName = locationResult.data?.location?.name;
    }

    // 3. OPTIMIZATION: Prefetch All Variants & Inventory Levels (Global Fetch)
    
    let skuMap = new Map(); // SKU -> { inventoryItemId, levels: Map<LocationId, Qty> }
    
    let hasNextPage = true;
    let endCursor = null;

    console.log("Prefetching inventory data...");
    while (hasNextPage) {
        const query = `#graphql
        query getInventoryData($after: String) {
            productVariants(first: 250, after: $after) {
                pageInfo { hasNextPage endCursor }
                edges {
                    node {
                        sku
                        inventoryItem {
                            id
                            inventoryLevels(first: 50) {
                                edges {
                                    node {
                                        location { id }
                                        quantities(names: ["available"]) { quantity name }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }`;
        
        const res = await admin.graphql(query, { variables: { after: endCursor } });
        const data = await res.json();
        
        data.data?.productVariants?.edges.forEach(edge => {
            const node = edge.node;
            if (node.sku) {
                const levels = new Map();
                node.inventoryItem?.inventoryLevels?.edges.forEach(lvl => {
                     const qtyNode = lvl.node.quantities.find(q => q.name === "available");
                     if (qtyNode) levels.set(lvl.node.location.id, qtyNode.quantity);
                });
                
                skuMap.set(node.sku.toLowerCase(), {
                    inventoryItemId: node.inventoryItem.id,
                    levels: levels
                });
            }
        });
        
        hasNextPage = data.data?.productVariants?.pageInfo?.hasNextPage;
        endCursor = data.data?.productVariants?.pageInfo?.endCursor;
    }
    console.log(`Prefetched ${skuMap.size} variants.`);

    // 4. PROCESS ROWS (In-Memory Validation)
    const processedCombinations = new Set();
    const bulkUpdates = []; 

    for (const row of rows) {
        try {
            if (!row["SKU"] || row["SKU"] === "SKU") continue;

            const sku = String(row["SKU"]).trim(); // Keep original for display
            const skuKey = sku.toLowerCase();     // Lowercase for matching
            const quantityRaw = row["Quantity Available"];
            const quantity = parseInt(quantityRaw);

            if (isNaN(quantity) || quantity === null || quantity === undefined) {
                results.errors.push(`Skipped SKU ${sku}: Invalid or missing quantity value`);
                results.failedRows.push({ ...row, "Error Reason": 'Invalid or missing quantity value' });
                continue;
            }

            const sheetLocationRaw = row["Inventory Location"];
            const sheetLocation = sheetLocationRaw ? String(sheetLocationRaw).trim() : "";

            let targetLocationId = locationId;
            let targetLocationName = selectedLocationName;

            if (isAllLocationsMode) {
                if (!sheetLocation) {
                    results.errors.push(`Skipped SKU ${sku}: Inventory Location is required when "All Locations" is selected`);
                    results.failedRows.push({ ...row, "Error Reason": 'Inventory Location is required for All Locations mode' });
                    continue;
                }
                const foundLocation = allLocations.find(loc => loc.name.toLowerCase() === sheetLocation.toLowerCase());
                if (!foundLocation) {
                    results.errors.push(`Skipped SKU ${sku}: Location '${sheetLocation}' not found in store`);
                    results.failedRows.push({ ...row, "Error Reason": `Location '${sheetLocation}' not found in store` });
                    continue;
                }
                targetLocationId = foundLocation.id;
                targetLocationName = foundLocation.name;
            } else {
                 if (sheetLocation && sheetLocation.toLowerCase() !== selectedLocationName.toLowerCase()) {
                    results.errors.push(`Skipped SKU ${sku}: Location in sheet '${sheetLocation}' does not match selected location '${selectedLocationName}'`);
                    results.failedRows.push({ ...row, "Error Reason": `Location mismatch: '${sheetLocation}' ≠ '${selectedLocationName}'` });
                    continue;
                }
            }

            const combinationKey = `${skuKey}|${targetLocationName}`;
            if (processedCombinations.has(combinationKey)) {
                results.errors.push(`Skipped SKU ${sku}: You have identical row having same SKU and location`);
                results.failedRows.push({ ...row, "Error Reason": 'You have identical row having same SKU and location' });
                continue;
            }
            processedCombinations.add(combinationKey);

            // --- LOOKUP & VALIDATION (In-Memory) ---
            const variantData = skuMap.get(skuKey);
            
            if (!variantData) {
                results.errors.push(`Variant not found for SKU: ${sku}`);
                results.failedRows.push({ ...row, "Error Reason": 'Variant not found' });
                continue;
            }

            const currentQty = variantData.levels.get(targetLocationId);
            
            if (currentQty === undefined) {
                 // Try to be more lenient? If undefined, we can't update via 'inventorySetQuantities' easily
                 // unless we are sure. But let's stick to skipping for safety.
                 results.errors.push(`Skipped SKU ${sku}: SKU don't have this location (or not stocked)`);
                 results.failedRows.push({ ...row, "Error Reason": `SKU don't have this location` });
                 continue;
            }

            if (currentQty === quantity) {
                results.skippedRows.push({ ...row, "Reason": 'Quantity already matches' });
                continue;
            }

            // Valid Update! Add to queue.
            bulkUpdates.push({
                inventoryItemId: variantData.inventoryItemId,
                locationId: targetLocationId,
                quantity: quantity
            });

        } catch (error) {
            results.errors.push(`Error processing SKU ${row["SKU"]}: ${error.message}`);
            results.failedRows.push({ ...row, "Error Reason": error.message });
        }
    }

    console.log(`Validation complete. Bulk Updates Queue: ${bulkUpdates.length}`);

    // 5. EXECUTE UPDATES (Bulk vs Immediate)
    
    if (bulkUpdates.length === 0) {
        return { success: true, results };
    }

    // Prepare JSONL for Bulk
    const jsonlLines = [];
    let currentBatch = [];
    const BATCH_SIZE = 1; // 1 mutation per row for accurate counting and granular error reporting
    
    for (const update of bulkUpdates) {
        currentBatch.push(update);
        if (currentBatch.length >= BATCH_SIZE) {
            jsonlLines.push(JSON.stringify({
                input: {
                    reason: "correction",
                    name: "available",
                    ignoreCompareQuantity: true,
                    quantities: currentBatch
                }
            }));
            currentBatch = [];
        }
    }
    if (currentBatch.length > 0) {
        jsonlLines.push(JSON.stringify({
            input: {
                reason: "correction",
                name: "available",
                ignoreCompareQuantity: true,
                quantities: currentBatch
            }
        }));
    }

    const { stagedUploadsCreate, userErrors: stageErrors } = await (await admin.graphql(`#graphql
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { field message }
        }
    }`, {
        variables: {
            input: [{
                filename: "updates.jsonl",
                mimeType: "text/jsonl",
                httpMethod: "POST",
                resource: "BULK_MUTATION_VARIABLES"
            }]
        }
    })).json().then(r => r.data || {});

    if (stageErrors?.length > 0 || stagedUploadsCreate?.userErrors?.length > 0) {
        const msg = stageErrors?.[0]?.message || stagedUploadsCreate?.userErrors?.[0]?.message;
        results.errors.push("Failed to create upload target: " + msg);
        return { success: true, results };
    }

    const target = stagedUploadsCreate?.stagedTargets?.[0];
    if (target) {
        const formData = new FormData();
        const keyParam = target.parameters.find(p => p.name === "key");
        const uploadPath = keyParam?.value; // Use the 'key' as the path

        target.parameters.forEach(p => formData.append(p.name, p.value));
        formData.append("file", new Blob([jsonlLines.join("\n")], { type: "text/jsonl" }));

        const uploadRes = await fetch(target.url, { method: "POST", body: formData });
        if (!uploadRes.ok) {
             results.errors.push(`Upload failed: ${uploadRes.statusText}`);
             return { success: true, results };
        }

        const bulkRes = await admin.graphql(`#graphql
        mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
            bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
                bulkOperation { id }
                userErrors { field message }
            }
        }`, {
            variables: {
                mutation: `mutation call($input: InventorySetQuantitiesInput!) {
                    inventorySetQuantities(input: $input) {
                        inventoryAdjustmentGroup { id }
                        userErrors { field message }
                    }
                }`,
                stagedUploadPath: uploadPath // Key is safer than resourceUrl
            }
        });
        
        const bulkData = await bulkRes.json();
        if (bulkData.data?.bulkOperationRunMutation?.userErrors?.length > 0) {
             results.errors.push("Bulk Mutation Error: " + bulkData.data.bulkOperationRunMutation.userErrors[0].message);
        } else {
             const opId = bulkData.data?.bulkOperationRunMutation?.bulkOperation?.id;
             console.log("Bulk Op Started:", opId, "Upload Key:", uploadPath);
             
             if (opId) {
                 results.bulkOperationId = opId;
             } else {
                 results.errors.push("Failed to trigger backend bulk operation (No ID returned)");
             }
        }
    } else {
        results.errors.push("Failed to get upload target URL");
    }

    return { success: true, results };
};

export default function ImportProductData() {
    const shopify = useAppBridge();
    const fetcher = useFetcher();
    const loaderFetcher = useFetcher();
    const pollFetcher = useFetcher(); 
    
    const [file, setFile] = useState(null);
    const [parsedData, setParsedData] = useState(null);
    const [selectedLocation, setSelectedLocation] = useState("SELECT_LOCATION");
    const [progress, setProgress] = useState(0);
    const [isProgressVisible, setIsProgressVisible] = useState(false);
    const fileInputRef = useRef(null);

    // Initial Results (from immediate validation)
    const [validatedResults, setValidatedResults] = useState(null);
    // Final Results (merged with bulk)
    const [finalResults, setFinalResults] = useState(null);

    const [failedPage, setFailedPage] = useState(1);
    const failedRowsPerPage = 10;
    const [skippedPage, setSkippedPage] = useState(1);
    const skippedRowsPerPage = 10;

    const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";
    const locations = loaderFetcher.data?.locations || [];

    useEffect(() => {
        loaderFetcher.load("/app/import-product-data");
    }, []);

    const handleFileChange = (e) => {
        const selectedFile = e.target.files[0];
        if (selectedFile) {
            setFile(selectedFile);
            setFailedPage(1);
            setSkippedPage(1);
            setValidatedResults(null); 
            setFinalResults(null);

            // CLEAR INPUT so same file can be selected again
            e.target.value = ""; 

            const reader = new FileReader();
            reader.onload = async (event) => {
                const buffer = event.target.result;
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.load(buffer);
                const worksheet = workbook.worksheets[0];
                const jsonData = [];
                const headers = [];
                worksheet.getRow(1).eachCell((cell, colNumber) => {
                   // Clean headers
                   headers[colNumber] = cell.value ? String(cell.value).trim() : "";
                });
                worksheet.eachRow((row, rowNumber) => {
                    if (rowNumber > 1) {
                        const rowData = {};
                        row.eachCell((cell, colNumber) => {
                            if (headers[colNumber]) rowData[headers[colNumber]] = cell.value;
                        });
                        if (rowData["SKU"] && String(rowData["SKU"]).trim() !== "") {
                            jsonData.push(rowData);
                        }
                    }
                });
                setParsedData(jsonData);
                if (!selectedLocation) {
                    shopify.toast.show("Please select a location first");
                    return;
                }
                shopify.toast.show(`File loaded: ${jsonData.length} rows. Starting analysis & import...`);
                // Start Progress for Analysis Phase
                setIsProgressVisible(true);
                setProgress(10); 
                fetcher.submit({ data: JSON.stringify(jsonData), locationId: selectedLocation }, { method: "POST" });
            };
            reader.readAsArrayBuffer(selectedFile);
        }
    };

    const handleButtonClick = () => {
        if (!selectedLocation) {
             shopify.toast.show("Please select a location first");
             return;
        }
        if (fileInputRef.current) fileInputRef.current.click();
    };

    // --- HANDLE ACTION RESPONSE ---
    useEffect(() => {
        if (fetcher.data?.success && fetcher.state === "idle") {
            const res = fetcher.data.results;
            setValidatedResults(res);

            if (res.bulkOperationId) {
                // Bulk job started for the updates!
                pollFetcher.load(`/app/import-product-data?checkStatus=true&operationId=${res.bulkOperationId}`);
            } else {
                // No bulk job (either 0 updates or error).
                setFinalResults(res); 
                setProgress(100);
                setTimeout(() => setIsProgressVisible(false), 2000);
                shopify.toast.show(`Import complete. ${res.updated} updated.`);
            }
        }
    }, [fetcher.data, fetcher.state]);

    // --- POLLING ---
    useEffect(() => {
        if (validatedResults?.bulkOperationId) {
             const opId = validatedResults.bulkOperationId;
             if (pollFetcher.data && pollFetcher.data.operationId) {
                  // CHECK ID MATCH to avoid stale data
                  if (pollFetcher.data.operationId !== opId) return;

                  if (pollFetcher.data.status === "RUNNING" || pollFetcher.data.status === "CREATED") {
                       // Keep polling
                       const timer = setTimeout(() => {
                           pollFetcher.load(`/app/import-product-data?checkStatus=true&operationId=${opId}`);
                       }, 2000);
                       return () => clearTimeout(timer);
                  } else if (pollFetcher.data.status === "COMPLETED") {
                       // Merge results!
                       const bulkRes = pollFetcher.data.bulkResults || { updated: 0, errors: [] };
                       
                       const merged = {
                           ...validatedResults,
                           updated: validatedResults.updated + bulkRes.updated, 
                           errors: [...validatedResults.errors, ...bulkRes.errors]
                       };
                       setFinalResults(merged);
                       setProgress(100);
                       shopify.toast.show(`Import complete. ${merged.updated} updated.`);
                       setTimeout(() => setIsProgressVisible(false), 2000);
                  } else if (pollFetcher.data.status === "FAILED") {
                       shopify.toast.show("Background update failed.");
                       setIsProgressVisible(false);
                  }
             }
        }
    }, [pollFetcher.data, validatedResults]);

    // --- PROGRESS UI ---
    useEffect(() => {
        if (isLoading) {
             const interval = setInterval(() => {
                setProgress((prev) => (prev < 60 ? prev + 5 : prev));
            }, 500);
            return () => clearInterval(interval);
        } else if (validatedResults?.bulkOperationId && !finalResults) {
             const interval = setInterval(() => {
                setProgress((prev) => (prev < 90 ? prev + 1 : prev));
            }, 1000);
            return () => clearInterval(interval);
        }
    }, [isLoading, validatedResults, finalResults]);

    const displayResults = finalResults || validatedResults;

    return (
        <s-page heading="Import Product Inventory Data">
            <s-box paddingBlockStart="large">
                <s-section heading="Select a location and upload an Excel file with SKU and Quantity Available columns. Other columns are optional.">
                    <s-select
                        label="Choose Location"
                        value={selectedLocation}
                        onChange={(e) => setSelectedLocation(e.target.value)}
                    >
                        <s-option value="SELECT_LOCATION" disabled>- Select -</s-option>
                        <s-option value="ALL_LOCATIONS">All Locations</s-option>
                        <s-option-group label="Available Store Locations">
                            {locations.map((location) => (
                                <s-option key={location.id} value={location.id}>
                                    {location.name}
                                </s-option>
                            ))}
                        </s-option-group>
                    </s-select>

                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".xlsx,.xls"
                        onChange={handleFileChange}
                        style={{ display: 'none' }}
                    />

                    <s-button
                        variant="primary"
                        onClick={handleButtonClick}
                        loading={(isLoading || (validatedResults?.bulkOperationId && !finalResults)) ? "true" : undefined}
                        disabled={!selectedLocation || selectedLocation === "SELECT_LOCATION" ? "disabled" : undefined}
                        paddingBlock="large"
                    >
                        Import Products
                    </s-button>

                    {selectedLocation === "ALL_LOCATIONS" && (
                        <s-box paddingBlockStart="small-100">
                            <s-banner tone="warning">
                                <s-text as="p" tone="critical">
                                    <strong>Inventory Location column is required for All Locations mode.</strong> Make sure your Excel file includes this column with valid location names.
                                </s-text>
                            </s-banner>
                        </s-box>
                    )}
                </s-section>
            </s-box>

            {isProgressVisible && (
                <div style={{
                    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center',
                    gap: '16px', width: '300px'
                }}>
                    <ProgressBar progress={progress} size="small" />
                    <s-text variant="bodyLg">
                         {validatedResults?.bulkOperationId && !finalResults ? "Processing updates..." : "Analyzing file..."}
                    </s-text>
                </div>
            )}

            {displayResults && !isProgressVisible && (
                <>
                    <s-box paddingBlockStart="large">
                        <s-section heading="Import Results">
                            <s-stack gap="200" direction="block">
                                <s-text as="p">Total rows: {displayResults.total}</s-text>
                                <s-text as="p">Successfully updated: {displayResults.updated}</s-text>
                                <s-text as="p">Skipped: {displayResults.skippedRows?.length || 0}</s-text>
                                <s-text as="p">Errors: {displayResults.errors.length}</s-text>
                            </s-stack>
                        </s-section>
                    </s-box>

                    {displayResults.failedRows?.length > 0 && (
                        <s-box paddingBlockStart="large">
                            <s-section heading={`❌ Failed Rows (${displayResults.failedRows.length})`}>
                                <s-table>
                                    <s-table-header-row>
                                        {Object.keys(displayResults.failedRows[0] || {}).map((key) => (
                                            <s-table-header key={key}>{key}</s-table-header>
                                        ))}
                                    </s-table-header-row>
                                    <s-table-body>
                                        {displayResults.failedRows
                                            .slice((failedPage - 1) * failedRowsPerPage, failedPage * failedRowsPerPage)
                                            .map((row, index) => (
                                                <s-table-row key={index}>
                                                    {Object.keys(displayResults.failedRows[0] || {}).map((key, cellIndex) => (
                                                        <s-table-cell key={cellIndex}>
                                                            {row[key]?.toString() || '-'}
                                                        </s-table-cell>
                                                    ))}
                                                </s-table-row>
                                            ))}
                                    </s-table-body>
                                </s-table>
                                {displayResults.failedRows.length > failedRowsPerPage && (
                                    <Pagination
                                        hasPrevious={failedPage > 1}
                                        onPrevious={() => setFailedPage(failedPage - 1)}
                                        hasNext={failedPage < Math.ceil(displayResults.failedRows.length / failedRowsPerPage)}
                                        onNext={() => setFailedPage(failedPage + 1)}
                                        type="table"
                                        label={`${((failedPage - 1) * failedRowsPerPage) + 1}-${Math.min(failedPage * failedRowsPerPage, displayResults.failedRows.length)} of ${displayResults.failedRows.length}`}
                                    />
                                )}
                            </s-section>
                        </s-box>
                    )}

                    {displayResults.skippedRows?.length > 0 && (
                        <s-box paddingBlockStart="large" paddingBlockEnd="large">
                            <s-section heading={`⏭️ Skipped Rows (${displayResults.skippedRows.length}) - Quantity Already Matches`}>
                                <s-table>
                                    <s-table-header-row>
                                        {Object.keys(displayResults.skippedRows[0] || {}).map((key) => (
                                            <s-table-header key={key}>{key}</s-table-header>
                                        ))}
                                    </s-table-header-row>
                                    <s-table-body>
                                        {displayResults.skippedRows
                                            .slice((skippedPage - 1) * skippedRowsPerPage, skippedPage * skippedRowsPerPage)
                                            .map((row, index) => (
                                                <s-table-row key={index}>
                                                    {Object.keys(displayResults.skippedRows[0] || {}).map((key, cellIndex) => (
                                                        <s-table-cell key={cellIndex}>
                                                            {row[key]?.toString() || '-'}
                                                        </s-table-cell>
                                                    ))}
                                                </s-table-row>
                                            ))}
                                    </s-table-body>
                                </s-table>
                                {displayResults.skippedRows.length > skippedRowsPerPage && (
                                    <Pagination
                                        hasPrevious={skippedPage > 1}
                                        onPrevious={() => setSkippedPage(skippedPage - 1)}
                                        hasNext={skippedPage < Math.ceil(displayResults.skippedRows.length / skippedRowsPerPage)}
                                        onNext={() => setSkippedPage(skippedPage + 1)}
                                        type="table"
                                        label={`${((skippedPage - 1) * skippedRowsPerPage) + 1}-${Math.min(skippedPage * skippedRowsPerPage, displayResults.skippedRows.length)} of ${displayResults.skippedRows.length}`}
                                    />
                                )}
                            </s-section>
                        </s-box>
                    )}
                </>
            )}
        </s-page>
    );
}
