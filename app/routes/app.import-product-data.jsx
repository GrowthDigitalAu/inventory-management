import { useState, useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Pagination, ProgressBar } from "@shopify/polaris";

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);


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
        skippedRows: []
    };


    const isAllLocationsMode = locationId === "ALL_LOCATIONS";


    let allLocations = [];
    if (isAllLocationsMode) {
        const locationsQuery = await admin.graphql(
            `#graphql
            query getLocations {
                locations(first: 250, includeLegacy: true, includeInactive: true) {
                    edges {
                        node {
                            id
                            name
                        }
                    }
                }
            }`
        );
        const locationsResult = await locationsQuery.json();
        allLocations = locationsResult.data?.locations?.edges.map(edge => ({
            id: edge.node.id,
            name: edge.node.name
        })) || [];
    }


    let selectedLocationName = null;
    if (!isAllLocationsMode) {
        const locationQuery = await admin.graphql(
            `#graphql
            query getLocation($id: ID!) {
                location(id: $id) {
                    name
                }
            }`,
            { variables: { id: locationId } }
        );
        const locationResult = await locationQuery.json();
        selectedLocationName = locationResult.data?.location?.name;
    }


    const processedCombinations = new Set();


    for (const row of rows) {
        try {

            if (!row["SKU"] || row["SKU"] === "SKU") {
                continue;
            }

            const sku = row["SKU"];
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
                if (sheetLocation) {
                    if (sheetLocation.toLowerCase() !== selectedLocationName.toLowerCase()) {
                        results.errors.push(`Skipped SKU ${sku}: Location in sheet '${sheetLocation}' does not match selected location '${selectedLocationName}'`);
                        results.failedRows.push({ ...row, "Error Reason": `Location mismatch: '${sheetLocation}' ≠ '${selectedLocationName}'` });
                        continue;
                    }
                }
            }


            const combinationKey = `${sku}|${targetLocationName}`;
            if (processedCombinations.has(combinationKey)) {
                results.errors.push(`Skipped SKU ${sku}: You have identical row having same SKU and location`);
                results.failedRows.push({ ...row, "Error Reason": 'You have identical row having same SKU and location' });
                continue;
            }
            processedCombinations.add(combinationKey);


            const variantQuery = await admin.graphql(
                `#graphql
                query findVariantBySKU($query: String!) {
                    productVariants(first: 1, query: $query) {
                        edges {
                            node {
                                id
                                sku
                                inventoryItem {
                                    id
                                    inventoryLevels(first: 50) {
                                        edges {
                                            node {
                                                location {
                                                    id
                                                }
                                                quantities(names: ["available"]) {
                                                    quantity
                                                    name
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }`,
                {
                    variables: {
                        query: `sku:${sku}`
                    }
                }
            );

            const variantResult = await variantQuery.json();
            const variant = variantResult.data?.productVariants?.edges[0]?.node;

            if (!variant) {
                results.errors.push(`Variant not found for SKU: ${sku}`);
                results.failedRows.push({ ...row, "Error Reason": 'Variant not found' });
                continue;
            }


            let currentQuantity = 0;
            let locationFound = false;
            const inventoryLevels = variant.inventoryItem.inventoryLevels?.edges || [];
            for (const level of inventoryLevels) {
                if (level.node.location.id === targetLocationId) {
                    const availableQty = level.node.quantities.find(q => q.name === "available");
                    currentQuantity = availableQty?.quantity || 0;
                    locationFound = true;
                    break;
                }
            }


            if (!locationFound) {
                results.errors.push(`Skipped SKU ${sku}: SKU don't have this location`);
                results.failedRows.push({ ...row, "Error Reason": `SKU don't have this location` });
                continue;
            }


            if (currentQuantity === quantity) {
                results.skippedRows.push({ ...row, "Reason": 'Quantity already matches' });
                continue;
            }


            const updateMutation = await admin.graphql(
                `#graphql
                mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
                    inventorySetQuantities(input: $input) {
                        inventoryAdjustmentGroup {
                            id
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }`,
                {
                    variables: {
                        input: {
                            reason: "correction",
                            name: "available",
                            ignoreCompareQuantity: true,
                            quantities: [
                                {
                                    inventoryItemId: variant.inventoryItem.id,
                                    locationId: targetLocationId,
                                    quantity: quantity
                                }
                            ]
                        }
                    }
                }
            );

            const updateResult = await updateMutation.json();

            if (updateResult.data?.inventorySetQuantities?.userErrors?.length > 0) {
                const errorMsg = updateResult.data.inventorySetQuantities.userErrors[0].message;
                results.errors.push(`Error updating SKU ${sku}: ${errorMsg}`);
                results.failedRows.push({ ...row, "Error Reason": errorMsg });
            } else {
                results.updated++;
            }

        } catch (error) {
            results.errors.push(`Error processing SKU ${row["SKU"]}: ${error.message}`);
            results.failedRows.push({ ...row, "Error Reason": error.message });
        }
    }

    return { success: true, results };
};

export default function ImportProductData() {
    const shopify = useAppBridge();
    const fetcher = useFetcher();
    const loaderFetcher = useFetcher();
    const [file, setFile] = useState(null);
    const [parsedData, setParsedData] = useState(null);
    const [selectedLocation, setSelectedLocation] = useState("SELECT_LOCATION");
    const [progress, setProgress] = useState(0);
    const [isProgressVisible, setIsProgressVisible] = useState(false);
    const fileInputRef = useRef(null);


    const [failedPage, setFailedPage] = useState(1);
    const failedRowsPerPage = 10;


    const [skippedPage, setSkippedPage] = useState(1);
    const skippedRowsPerPage = 10;

    const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";
    const locations = loaderFetcher.data?.locations || [];

    useEffect(() => {

        loaderFetcher.load("/app/import-product-data");
    }, []);

    useEffect(() => {
        if (isLoading) {
            setIsProgressVisible(true);
            setProgress(0);

            const rowCount = parsedData ? parsedData.length : 0;

            const estimatedTimeMs = Math.max(rowCount * 500, 2000);
            const intervalMs = 100;


            const totalSteps = estimatedTimeMs / intervalMs;
            const linearIncrement = 90 / totalSteps;

            const interval = setInterval(() => {
                setProgress((prev) => {
                    if (prev < 90) {

                        return Math.min(prev + linearIncrement, 90);
                    } else {

                        const target = 99;
                        const remaining = target - prev;

                        return prev + Math.max(remaining * 0.01, 0.01);
                    }
                });
            }, intervalMs);
            return () => clearInterval(interval);
        } else if (isProgressVisible && !isLoading) {

            setProgress(100);
        }
    }, [isLoading, isProgressVisible, parsedData]);


    useEffect(() => {
        if (!isLoading && fetcher.data?.results && isProgressVisible) {

            const timeout = setTimeout(() => {
                setIsProgressVisible(false);
            }, 300);
            return () => clearTimeout(timeout);
        }
    }, [isLoading, fetcher.data?.results, isProgressVisible]);

    const handleFileChange = (e) => {
        const selectedFile = e.target.files[0];
        if (selectedFile) {
            setFile(selectedFile);
            setFailedPage(1);
            setSkippedPage(1);


            const reader = new FileReader();
            reader.onload = async (event) => {
                const buffer = event.target.result;
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.load(buffer);

                const worksheet = workbook.worksheets[0];
                const jsonData = [];


                const headers = [];
                worksheet.getRow(1).eachCell((cell, colNumber) => {
                    headers[colNumber] = cell.value;
                });


                worksheet.eachRow((row, rowNumber) => {
                    if (rowNumber > 1) {
                        const rowData = {};
                        row.eachCell((cell, colNumber) => {
                            if (headers[colNumber]) {
                                rowData[headers[colNumber]] = cell.value;
                            }
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


                shopify.toast.show(`File loaded: ${jsonData.length} rows. Starting import...`);
                fetcher.submit(
                    {
                        data: JSON.stringify(jsonData),
                        locationId: selectedLocation
                    },
                    { method: "POST" }
                );
            };
            reader.readAsArrayBuffer(selectedFile);
        }
    };

    const handleButtonClick = () => {
        if (!selectedLocation) {
            shopify.toast.show("Please select a location first");
            return;
        }


        if (fileInputRef.current) {
            fileInputRef.current.click();
        }
    };


    useEffect(() => {
        if (fetcher.data?.success && fetcher.state === "idle") {
            const { results } = fetcher.data;
            shopify.toast.show(`Import complete: ${results.updated} updated, ${results.errors.length} errors`);


            setFile(null);
            setParsedData(null);
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
        }
    }, [fetcher.data, fetcher.state, shopify]);

    return (
        <s-page heading="Import Product Inventory Data">
            <s-box paddingBlockStart="large">
                <s-section
                    heading="Select a location and upload an Excel file with SKU and Quantity Available columns. Other columns are optional.">
                    <s-select
                        label="Choose Location"
                        value={selectedLocation}
                        onChange={(e) => setSelectedLocation(e.target.value)}
                    >
                        <s-option value="SELECT_LOCATION" disabled>- Select -</s-option>
                        <s-option value="ALL_LOCATIONS">All Locations</s-option>
                        {locations.map((location) => (
                            <s-option key={location.id} value={location.id}>
                                {location.name}
                            </s-option>
                        ))}
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
                        loading={isLoading ? "true" : undefined}
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
                    position: 'fixed',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    zIndex: 1000,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '16px',
                    width: '300px'
                }}>
                    <div style={{ width: '100%' }}>
                        <ProgressBar progress={progress} size="small" />
                    </div>
                    <s-text variant="bodyLg">Importing products...</s-text>
                    <s-div className="ProcessMain">
                        <s-text className="ProcessInner"></s-text>
                    </s-div>
                </div>
            )}

            {!isLoading && fetcher.data?.results && !isProgressVisible && (
                <>
                    <s-box paddingBlockStart="large">
                        <s-section heading="Import Results">
                            <s-stack gap="200" direction="block">
                                <s-text as="p">Total rows: {fetcher.data.results.total}</s-text>
                                <s-text as="p">Successfully updated: {fetcher.data.results.updated}</s-text>
                                <s-text as="p">Skipped: {fetcher.data.results.skippedRows?.length || 0}</s-text>
                                <s-text as="p">Errors: {fetcher.data.results.errors.length}</s-text>
                            </s-stack>
                        </s-section>
                    </s-box>

                    {fetcher.data.results.failedRows?.length > 0 && (
                        <s-box paddingBlockStart="large">
                            <s-section heading={`❌ Failed Rows (${fetcher.data.results.failedRows.length})`}>
                                <s-table>
                                    <s-table-header-row>
                                        {Object.keys(fetcher.data.results.failedRows[0] || {}).map((key) => (
                                            <s-table-header key={key}>{key}</s-table-header>
                                        ))}
                                    </s-table-header-row>
                                    <s-table-body>
                                        {fetcher.data.results.failedRows
                                            .slice((failedPage - 1) * failedRowsPerPage, failedPage * failedRowsPerPage)
                                            .map((row, index) => (
                                                <s-table-row key={index}>
                                                    {Object.keys(fetcher.data.results.failedRows[0] || {}).map((key, cellIndex) => (
                                                        <s-table-cell key={cellIndex}>
                                                            {row[key]?.toString() || '-'}
                                                        </s-table-cell>
                                                    ))}
                                                </s-table-row>
                                            ))}
                                    </s-table-body>
                                </s-table>
                                {fetcher.data.results.failedRows.length > failedRowsPerPage && (
                                    <Pagination
                                        hasPrevious={failedPage > 1}
                                        onPrevious={() => setFailedPage(failedPage - 1)}
                                        hasNext={failedPage < Math.ceil(fetcher.data.results.failedRows.length / failedRowsPerPage)}
                                        onNext={() => setFailedPage(failedPage + 1)}
                                        type="table"
                                        label={`${((failedPage - 1) * failedRowsPerPage) + 1}-${Math.min(failedPage * failedRowsPerPage, fetcher.data.results.failedRows.length)} of ${fetcher.data.results.failedRows.length}`}
                                    />
                                )}
                            </s-section>
                        </s-box>
                    )}

                    {fetcher.data.results.skippedRows?.length > 0 && (
                        <s-box paddingBlockStart="large" paddingBlockEnd="large">
                            <s-section heading={`⏭️ Skipped Rows (${fetcher.data.results.skippedRows.length}) - Quantity Already Matches`}>
                                <s-table>
                                    <s-table-header-row>
                                        {Object.keys(fetcher.data.results.skippedRows[0] || {}).map((key) => (
                                            <s-table-header key={key}>{key}</s-table-header>
                                        ))}
                                    </s-table-header-row>
                                    <s-table-body>
                                        {fetcher.data.results.skippedRows
                                            .slice((skippedPage - 1) * skippedRowsPerPage, skippedPage * skippedRowsPerPage)
                                            .map((row, index) => (
                                                <s-table-row key={index}>
                                                    {Object.keys(fetcher.data.results.skippedRows[0] || {}).map((key, cellIndex) => (
                                                        <s-table-cell key={cellIndex}>
                                                            {row[key]?.toString() || '-'}
                                                        </s-table-cell>
                                                    ))}
                                                </s-table-row>
                                            ))}
                                    </s-table-body>
                                </s-table>
                                {fetcher.data.results.skippedRows.length > skippedRowsPerPage && (
                                    <Pagination
                                        hasPrevious={skippedPage > 1}
                                        onPrevious={() => setSkippedPage(skippedPage - 1)}
                                        hasNext={skippedPage < Math.ceil(fetcher.data.results.skippedRows.length / skippedRowsPerPage)}
                                        onNext={() => setSkippedPage(skippedPage + 1)}
                                        type="table"
                                        label={`${((skippedPage - 1) * skippedRowsPerPage) + 1}-${Math.min(skippedPage * skippedRowsPerPage, fetcher.data.results.skippedRows.length)} of ${fetcher.data.results.skippedRows.length}`}
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
