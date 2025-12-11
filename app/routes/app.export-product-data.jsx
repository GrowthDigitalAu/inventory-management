import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";
import { useAppBridge } from "@shopify/app-bridge-react";
import { ProgressBar } from "@shopify/polaris";


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
    const locationId = formData.get("locationId");

    const response = await admin.graphql(
        `#graphql
    query getProducts {
      products(first: 50) {
        edges {
          node {
            title
            variants(first: 10) {
              edges {
                node {
                  title
                  sku
                  selectedOptions {
                    name
                    value
                  }
                  inventoryItem {
                    inventoryLevels(first: 10) {
                      edges {
                        node {
                          location {
                            id
                            name
                          }
                          quantities(names: ["available"]) {
                            quantity
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`
    );

    const responseJson = await response.json();

    if (responseJson.errors) {
        return { success: false, error: "GraphQL errors occurred" };
    }

    const products = responseJson.data?.products?.edges || [];

    const rows = [];
    products.forEach((productEdge) => {
        const product = productEdge.node;

        product.variants.edges.forEach((variantEdge) => {
            const variant = variantEdge.node;
            const options = {};
            options["Option1 Value"] = "";
            options["Option2 Value"] = "";
            options["Option3 Value"] = "";

            variant.selectedOptions.forEach((opt, index) => {
                if (index < 3) {
                    options[`Option${index + 1} Value`] = opt.value;
                }
            });

            const inventoryEdges = variant.inventoryItem?.inventoryLevels?.edges || [];


            const filteredInventory = (locationId && locationId !== "ALL_LOCATIONS")
                ? inventoryEdges.filter(edge => edge.node.location.id === locationId)
                : inventoryEdges;

            if (filteredInventory.length === 0) {

                if (!locationId || locationId === "ALL_LOCATIONS") {
                    rows.push({
                        "Product Title": product.title,
                        "SKU": variant.sku || "",
                        "Option1 Value": options["Option1 Value"],
                        "Option2 Value": options["Option2 Value"],
                        "Option3 Value": options["Option3 Value"],
                        "Inventory Location": "N/A",
                        "Quantity Available": 0
                    });
                }
            } else {
                filteredInventory.forEach((levelEdge) => {
                    const level = levelEdge.node;
                    rows.push({
                        "Product Title": product.title,
                        "SKU": variant.sku || "",
                        "Option1 Value": options["Option1 Value"],
                        "Option2 Value": options["Option2 Value"],
                        "Option3 Value": options["Option3 Value"],
                        "Inventory Location": level.location.name,
                        "Quantity Available": level.quantities[0]?.quantity || 0
                    });
                });
            }
        });
    });

    if (rows.length === 0) {
        rows.push({
            "Product Title": "No data found",
            "SKU": "",
            "Option1 Value": "",
            "Option2 Value": "",
            "Option3 Value": "",
            "Inventory Location": "",
            "Quantity Available": ""
        });
    }

    return { success: true, rows };
};

export default function ExportProductData() {
    const shopify = useAppBridge();
    const fetcher = useFetcher();
    const loaderFetcher = useFetcher();
    const [selectedLocation, setSelectedLocation] = useState("SELECT_LOCATION");
    const [progress, setProgress] = useState(0);
    const [isProgressVisible, setIsProgressVisible] = useState(false);

    const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";
    const locations = loaderFetcher.data?.locations || [];

    useEffect(() => {

        loaderFetcher.load("/app/export-product-data");
    }, []);

    useEffect(() => {
        if (isLoading) {
            setIsProgressVisible(true);
            setProgress(0);

            const estimatedTimeMs = 3000;
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
    }, [isLoading, isProgressVisible]);

    useEffect(() => {
        if (!isLoading && fetcher.data?.success && isProgressVisible) {
            const timeout = setTimeout(() => {
                setIsProgressVisible(false);
            }, 300);
            return () => clearTimeout(timeout);
        }
    }, [isLoading, fetcher.data?.success, isProgressVisible]);

    const handleExport = () => {
        shopify.toast.show("Exporting products...");
        fetcher.submit(
            { locationId: selectedLocation },
            { method: "POST" }
        );
    };

    useEffect(() => {
        if (fetcher.data?.success && fetcher.state === "idle") {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet("Products");

            worksheet.addRow(Object.keys(fetcher.data.rows[0] || {}));

            fetcher.data.rows.forEach(row => worksheet.addRow(Object.values(row)));

            workbook.xlsx.writeBuffer().then(buffer => {
                const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "products_export.xlsx";
                a.click();
                URL.revokeObjectURL(url);
                shopify.toast.show("Export complete");
            }).catch(err => {
                console.error(err);
                shopify.toast.show("Export failed");
            });
        } else if (fetcher.data?.error) {
            shopify.toast.show("Export failed");
        }
    }, [fetcher.data, fetcher.state, shopify]);

    return (
        <s-page heading="Export Product Inventory Data">
            <s-box paddingBlockStart="large" paddingBlockEnd="large">
                <s-section heading='Select a location to filter the export, or "All Locations" to export all locations.'>
                    <s-select
                        className="export-select-dropdown"
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
                    <s-button
                        variant="primary"
                        onClick={handleExport}
                        loading={isLoading ? "true" : undefined}
                        disabled={!selectedLocation || selectedLocation === "SELECT_LOCATION" ? "disabled" : undefined}
                        paddingBlock="large"
                    >
                        Export Product Data
                    </s-button>
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
                    <s-text variant="bodyLg">Exporting products...</s-text>
                    <s-div className="ProcessMain">
                        <s-text className="ProcessInner"></s-text>
                    </s-div>
                </div>
            )}
        </s-page>
    );
}
