// Global variables
let repoNames = [];
let allDatasets = [];
let summaryDetailedData = {};
let enabledRepos = new Set();
let includeFirstCommitSummary = false;  // Default to exclude first commit
let includeFailedBuilds = false;  // Default to exclude failed builds
let chart = null;
let summaryChart = null;
let currentTab = 0;
let allPlatforms = [];
let platformColors = {};
let enabledPlatforms = new Set(); // Track which platforms are enabled for display

// Generate colors for platforms dynamically
function generatePlatformColors(platforms) {
    const colors = [
        '#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336',
        '#607D8B', '#795548', '#FF5722', '#673AB7', '#3F51B5',
        '#009688', '#8BC34A', '#CDDC39', '#FFC107', '#FF9800'
    ];

    const colorMap = {};
    platforms.forEach((platform, index) => {
        colorMap[platform] = colors[index % colors.length];
    });

    return colorMap;
}

function getPlatformColor(platform) {
    return platformColors[platform] || '#607D8B';
}

// Generate human-readable platform names
function getPlatformDisplayName(platform) {
    const nameMap = {
        'garnix': 'Garnix',
        'github-actions-parallel': 'GitHub Actions (Parallel)',
        'github-actions-serial': 'GitHub Actions (Serial)',
        'github-actions-cachix-parallel': 'GitHub Actions + Cachix (Parallel)',
        'github-actions-cachix-serial': 'GitHub Actions + Cachix (Serial)',
        'github-actions-magic-nix-cache-parallel': 'GitHub Actions + Magic Nix Cache (Parallel)',
        'nixbuild-net': 'nixbuild.net'
    };

    return nameMap[platform] || platform.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

// Load data from JSON file
async function loadData() {
    try {
        const response = await fetch('dashboard_data.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();

        // Process the data structure
        repoNames = data.repo_names;
        allDatasets = data.datasets;
        summaryDetailedData = data.summary_detailed_data || {};

        // Initialize all repos as enabled
        enabledRepos = new Set(repoNames);

        // Extract all unique platforms from the datasets
        const platformSet = new Set();
        allDatasets.forEach(repoDatasets => {
            repoDatasets.forEach(dataset => {
                platformSet.add(dataset.label);
            });
        });
        allPlatforms = Array.from(platformSet).sort();

        // Generate colors for all platforms
        platformColors = generatePlatformColors(allPlatforms);
        
        // Initialize all platforms as enabled by default
        enabledPlatforms = new Set(allPlatforms);

        // Update dataset colors to use dynamically generated colors
        updateDatasetColors();

        // Hide loading, show dashboard
        document.getElementById('loading').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';

        // Initialize the dashboard
        initializeDashboard();

    } catch (error) {
        console.error('Error loading data:', error);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
    }
}

function calculateSummaryData() {
    if (Object.keys(summaryDetailedData).length === 0 || enabledRepos.size === 0) {
        return [];
    }

    const enabledReposArray = Array.from(enabledRepos);
    const platformSlowdownFactors = {};

    // For each enabled repository, calculate slowdown factors
    for (const repo of enabledReposArray) {
        const repoTimes = {};

        // Get filtered times for this repo across all platforms
        for (const [platform, repoData] of Object.entries(summaryDetailedData)) {
            if (repoData[repo]) {
                // Filter commits based on settings
                const filteredCommits = repoData[repo].filter(commit => {
                    // Filter by first commit setting
                    if (commit.commit_index === 0 && !includeFirstCommitSummary) {
                        return false;
                    }

                    // Filter by failed builds setting (timed_out and early_fail are not considered failed builds for filtering)
                    if (commit.status === 'failure' && !includeFailedBuilds) {
                        return false;
                    }

                    return true;
                });

                if (filteredCommits.length > 0) {
                    // Calculate average for this repo/platform combination
                    const avgTime = filteredCommits.reduce((sum, commit) => sum + commit.time_minutes, 0) / filteredCommits.length;
                    repoTimes[platform] = avgTime;
                }
            }
        }

        // Only proceed if we have data for this repo
        if (Object.keys(repoTimes).length === 0) {
            continue;
        }

        // Find fastest platform for this repo
        const fastestTimeForRepo = Math.min(...Object.values(repoTimes));

        // Calculate slowdown factors for this repo
        for (const [platform, time] of Object.entries(repoTimes)) {
            if (!platformSlowdownFactors[platform]) {
                platformSlowdownFactors[platform] = [];
            }
            const slowdownFactor = time / fastestTimeForRepo;
            platformSlowdownFactors[platform].push(slowdownFactor);
        }
    }

    // Average the slowdown factors across repositories
    const summaryData = [];
    let excludedPlatforms = [];

    for (const [platform, slowdownFactors] of Object.entries(platformSlowdownFactors)) {
        if (slowdownFactors.length > 0) {
            // Check if this is github-actions-serial and crytic/echidna is enabled
            if (platform === 'github-actions-serial' && enabledRepos.has('crytic/echidna')) {
                excludedPlatforms.push({
                    platform: platform,
                    reason: 'GitHub Actions (Serial) errored in all builds of crytic/echidna, and is therefore not included.'
                });
                continue; // Skip this platform
            }

            const avgSlowdownFactor = slowdownFactors.reduce((a, b) => a + b, 0) / slowdownFactors.length;
            summaryData.push({
                platform: platform,
                slowdown_factor: avgSlowdownFactor,
                repo_count: slowdownFactors.length
            });
        }
    }

    return {
        data: summaryData.sort((a, b) => a.slowdown_factor - b.slowdown_factor),
        excluded: excludedPlatforms
    };
}

function createSummaryChart() {
    if (summaryChart) {
        summaryChart.destroy();
    }

    const summaryResult = calculateSummaryData();
    const summaryData = summaryResult.data;
    const excludedPlatforms = summaryResult.excluded;

    if (summaryData.length === 0) {
        return;
    }

    const summaryCtx = document.getElementById('summaryChart').getContext('2d');

    summaryChart = new Chart(summaryCtx, {
        type: 'bar',
        data: {
            labels: summaryData.map(d => getPlatformDisplayName(d.platform)),
            datasets: [{
                label: 'Slowdown Factor vs Fastest CI',
                data: summaryData.map(d => d.slowdown_factor),
                backgroundColor: summaryData.map(d => getPlatformColor(d.platform)),
                borderColor: summaryData.map(d => getPlatformColor(d.platform)),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: `CI Performance Summary: Relative Slowdown Comparison [lower is better] (${enabledRepos.size}/${repoNames.length} repos${includeFirstCommitSummary ? ', incl. first commits' : ''}${includeFailedBuilds ? ', incl. failed builds' : ''})`,
                    font: { size: 16 }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const data = summaryData[context.dataIndex];
                            return [
                                `Average slowdown factor: ${data.slowdown_factor.toFixed(2)}x slower`,
                                `Repositories tested: ${data.repo_count}/${enabledRepos.size}`
                            ];
                        }
                    }
                },
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Slowdown Factor (vs Fastest CI)'
                    },
                    ticks: {
                        callback: function(value) {
                            return value.toFixed(1) + 'x';
                        }
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'CI Platform'
                    }
                }
            }
        }
    });

    // Display exclusion notes if any
    displayExclusionNotes(excludedPlatforms);
}

function displayExclusionNotes(excludedPlatforms) {
    // Find or create exclusion notes container
    let notesContainer = document.getElementById('exclusionNotes');
    if (!notesContainer) {
        notesContainer = document.createElement('div');
        notesContainer.id = 'exclusionNotes';
        notesContainer.style.marginTop = '15px';
        notesContainer.style.fontSize = '14px';
        notesContainer.style.color = '#666';
        notesContainer.style.fontStyle = 'italic';

        // Insert after the summary chart
        const summaryChart = document.getElementById('summaryChart');
        summaryChart.parentNode.insertBefore(notesContainer, summaryChart.nextSibling);
    }

    // Clear and populate with exclusion notes
    notesContainer.innerHTML = '';
    if (excludedPlatforms.length > 0) {
        excludedPlatforms.forEach(excluded => {
            const note = document.createElement('div');
            note.textContent = excluded.reason;
            notesContainer.appendChild(note);
        });
    }
}

function createRepoCheckboxes() {
    const container = document.getElementById('repoCheckboxes');
    container.innerHTML = '';

    repoNames.forEach(repoName => {
        const label = document.createElement('label');
        label.className = 'filter-checkbox';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.onchange = () => updateRepoFilter(repoName, checkbox.checked);

        const span = document.createElement('span');
        span.className = 'checkmark';

        const text = document.createTextNode(repoName);

        label.appendChild(checkbox);
        label.appendChild(span);
        label.appendChild(text);
        container.appendChild(label);
    });
}

function updateRepoFilter(repoName, enabled) {
    if (enabled) {
        enabledRepos.add(repoName);
    } else {
        enabledRepos.delete(repoName);
    }

    // Recreate summary chart with new filter
    createSummaryChart();
}

function updateSummaryFirstCommitFilter() {
    includeFirstCommitSummary = document.getElementById('includeFirstCommitSummary').checked;
    createSummaryChart();
}

function updateSummaryFailedBuildsFilter() {
    includeFailedBuilds = document.getElementById('includeFailedBuildsSummary').checked;
    createSummaryChart();
}

function initializeDashboard() {
    // Create repository checkboxes
    createRepoCheckboxes();

    // Create summary chart
    createSummaryChart();

    // Create tab buttons
    const tabsContainer = document.getElementById('tabs');
    tabsContainer.innerHTML = '';

    repoNames.forEach((repoName, index) => {
        const button = document.createElement('button');
        button.className = `tab${index === 0 ? ' active' : ''}`;
        button.textContent = repoName;
        button.onclick = () => showTab(index);
        tabsContainer.appendChild(button);
    });

    // Create platform legend
    createPlatformLegend();

    // Initialize with first tab
    showTab(0);
}

function createPlatformLegend() {
    const platformsContainer = document.getElementById('platforms');
    platformsContainer.innerHTML = '';

    allPlatforms.forEach(platform => {
        const label = document.createElement('label');
        label.className = 'platform-checkbox';
        label.style.cursor = 'pointer';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true; // All platforms enabled by default
        checkbox.style.display = 'none'; // Hide the actual checkbox
        checkbox.onchange = () => updatePlatformFilter(platform, checkbox.checked);

        const tag = document.createElement('div');
        tag.className = 'platform-tag';
        tag.style.backgroundColor = getPlatformColor(platform);
        tag.textContent = getPlatformDisplayName(platform);
        
        // Add visual feedback for checked/unchecked state
        tag.style.opacity = checkbox.checked ? '1' : '0.4';
        tag.style.border = checkbox.checked ? '2px solid transparent' : '2px solid #ccc';
        
        // Add tooltip based on current state
        tag.setAttribute('data-tooltip', checkbox.checked ? 'Click to exclude from comparison' : 'Click to include in comparison');

        label.appendChild(checkbox);
        label.appendChild(tag);
        platformsContainer.appendChild(label);
    });
}

function updatePlatformFilter(platform, enabled) {
    if (enabled) {
        enabledPlatforms.add(platform);
    } else {
        enabledPlatforms.delete(platform);
    }
    
    // Update the visual appearance of the platform tag
    const platformsContainer = document.getElementById('platforms');
    const labels = platformsContainer.getElementsByClassName('platform-checkbox');
    
    Array.from(labels).forEach(label => {
        const checkbox = label.querySelector('input[type="checkbox"]');
        const tag = label.querySelector('.platform-tag');
        
        if (tag.textContent === getPlatformDisplayName(platform)) {
            tag.style.opacity = enabled ? '1' : '0.4';
            tag.style.border = enabled ? '2px solid transparent' : '2px solid #ccc';
            tag.setAttribute('data-tooltip', enabled ? 'Click to exclude from comparison' : 'Click to include in comparison');
        }
    });
    
    // Update the current chart to show/hide the platform
    if (currentTab >= 0) {
        createChart(allDatasets[currentTab], repoNames[currentTab]);
    }
}

function updatePlatformLegendDisplay() {
    // Update the visual state of platform checkboxes to stay in sync
    const platformsContainer = document.getElementById('platforms');
    const labels = platformsContainer.getElementsByClassName('platform-checkbox');
    
    Array.from(labels).forEach(label => {
        const checkbox = label.querySelector('input[type="checkbox"]');
        const tag = label.querySelector('.platform-tag');
        const platformDisplayName = tag.textContent;
        
        // Find the original platform name
        const platform = allPlatforms.find(p => getPlatformDisplayName(p) === platformDisplayName);
        if (platform) {
            const isEnabled = enabledPlatforms.has(platform);
            checkbox.checked = isEnabled;
            tag.style.opacity = isEnabled ? '1' : '0.4';
            tag.style.border = isEnabled ? '2px solid transparent' : '2px solid #ccc';
            tag.setAttribute('data-tooltip', isEnabled ? 'Click to exclude from comparison' : 'Click to include in comparison');
        }
    });
}

function updateDatasetColors() {
    // Update all datasets to use dynamically generated colors
    allDatasets.forEach(repoDatasets => {
        repoDatasets.forEach(dataset => {
            const color = getPlatformColor(dataset.label);
            dataset.borderColor = color;
            dataset.backgroundColor = color + '20'; // Add transparency
        });
    });
}

// Initialize Chart.js
const ctx = document.getElementById('performanceChart').getContext('2d');

function filterData(datasets) {
    const includeFirst = document.getElementById('includeFirst').checked;
    const includeOthers = document.getElementById('includeOthers').checked;
    const includeFailedBuildsChart = document.getElementById('includeFailedBuilds').checked;

    return datasets.map(dataset => {
        const filteredData = dataset.data.filter(point => {
            // Filter by commit position
            if (point.x === 0 && !includeFirst) {
                return false;
            }
            if (point.x !== 0 && !includeOthers) {
                return false;
            }

            // Filter by build status (only genuine failures are filtered, not early_fail or timed_out)
            if (point.status === 'failure' && !includeFailedBuildsChart) {
                return false;
            }

            return true;
        });

        // Separate genuine failures from other builds
        // Timed out and early_fail builds should have connecting lines (included in main data)
        const mainData = filteredData.filter(point => point.status !== 'failure');
        const failedData = filteredData.filter(point => point.status === 'failure');
        const earlyFailData = filteredData.filter(point => point.status === 'early_fail');

        return {
            ...dataset,
            data: mainData,
            failedData: failedData,
            earlyFailData: earlyFailData,
            hasEarlyFail: earlyFailData.length > 0
        };
    });
}

function calculateStats(datasets) {
    // Get filter settings
    const includeFirst = document.getElementById('includeFirst').checked;
    const includeOthers = document.getElementById('includeOthers').checked;
    const includeFailedBuildsChart = document.getElementById('includeFailedBuilds').checked;

    // Apply filtering to datasets for statistics calculation
    const filteredForStats = datasets.map(dataset => {
        const filteredData = dataset.data.filter(point => {
            // Filter by commit position
            if (point.x === 0 && !includeFirst) {
                return false;
            }
            if (point.x !== 0 && !includeOthers) {
                return false;
            }

            // Filter by build status (only genuine failures are filtered, not early_fail or timed_out)
            if (point.status === 'failure' && !includeFailedBuildsChart) {
                return false;
            }

            return true;
        });

        return {
            ...dataset,
            data: filteredData
        };
    });

    // First, collect all commit indices that exist across all platforms (from filtered data)
    const allCommitIndices = new Set();
    filteredForStats.forEach(dataset => {
        dataset.data.forEach(point => allCommitIndices.add(point.x));
    });
    const sortedIndices = Array.from(allCommitIndices).sort((a, b) => a - b);

    // Check if any platform is missing data
    let hasMissingData = false;
    filteredForStats.forEach(dataset => {
        const platformIndices = new Set(dataset.data.map(d => d.x));
        if (platformIndices.size !== sortedIndices.length) {
            hasMissingData = true;
        }
    });

    const stats = {};

    if (!hasMissingData) {
        // No missing data - calculate normally
        filteredForStats.forEach(dataset => {
            const times = dataset.data.map(d => d.y);
            if (times.length > 0) {
                // Check if any builds timed out (assuming 120 minutes = 2 hours timeout)
                const timedOutCount = dataset.data.filter(d => d.status === 'timed_out').length;
                const hasTimedOut = timedOutCount > 0;
                
                // Check if any builds are early_fail
                const earlyFailCount = dataset.data.filter(d => d.status === 'early_fail').length;
                const hasEarlyFail = earlyFailCount > 0;

                stats[dataset.label] = {
                    avg: times.reduce((a, b) => a + b, 0) / times.length,
                    min: Math.min(...times),
                    max: Math.max(...times),
                    count: times.length,
                    timedOutCount: timedOutCount,
                    hasTimedOut: hasTimedOut,
                    earlyFailCount: earlyFailCount,
                    hasEarlyFail: hasEarlyFail,
                    isProjected: false
                };
            }
        });
    } else {
        // Missing data - use projection method

        // Calculate speed factors for each platform relative to others
        const platformSpeedFactors = {};

        filteredForStats.forEach(dataset => {
            const platformData = new Map(dataset.data.map(d => [d.x, d.y]));
            let totalSpeedFactor = 0;
            let comparisons = 0;

            // Compare with other platforms for overlapping commits
            filteredForStats.forEach(otherDataset => {
                if (dataset.label === otherDataset.label) return;

                const otherData = new Map(otherDataset.data.map(d => [d.x, d.y]));

                // Find overlapping commits
                for (const [commitIndex, time] of platformData) {
                    if (otherData.has(commitIndex)) {
                        const otherTime = otherData.get(commitIndex);
                        if (otherTime > 0) {
                            const ratio = time / otherTime;
                            totalSpeedFactor += ratio;
                            comparisons++;
                        }
                    }
                }
            });

            if (comparisons > 0) {
                platformSpeedFactors[dataset.label] = totalSpeedFactor / comparisons;
            } else {
                platformSpeedFactors[dataset.label] = 1.0; // fallback
            }
        });

        // Calculate projected averages
        filteredForStats.forEach(dataset => {
            const platformData = new Map(dataset.data.map(d => [d.x, d.y]));
            const actualTimes = dataset.data.map(d => d.y);

            if (actualTimes.length === 0) return;

            const speedFactor = platformSpeedFactors[dataset.label];
            let projectedSum = 0;
            let totalCount = 0;
            let missingCount = 0;

            // Process all possible commits (both actual and missing)
            sortedIndices.forEach(commitIndex => {
                if (platformData.has(commitIndex)) {
                    // Use actual value
                    projectedSum += platformData.get(commitIndex);
                    totalCount++;
                } else {
                    // Missing data point - project from other platforms
                    let projectedValue = 0;
                    let sourceCount = 0;

                    filteredForStats.forEach(otherDataset => {
                        if (dataset.label === otherDataset.label) return;
                        const otherData = new Map(otherDataset.data.map(d => [d.x, d.y]));

                        if (otherData.has(commitIndex)) {
                            projectedValue += otherData.get(commitIndex);
                            sourceCount++;
                        }
                    });

                    if (sourceCount > 0) {
                        // Average other platforms' times and apply speed factor
                        const avgOtherTime = projectedValue / sourceCount;
                        projectedSum += avgOtherTime * speedFactor;
                        totalCount++;
                        missingCount++;
                    }
                }
            });

            const actualAvg = actualTimes.length > 0 ? actualTimes.reduce((a, b) => a + b, 0) / actualTimes.length : 0;
            const projectedAvg = totalCount > 0 ? projectedSum / totalCount : 0;

            // Check for timed out builds in projected method
            const timedOutCount = dataset.data.filter(d => d.status === 'timed_out').length;
            const hasTimedOut = timedOutCount > 0;
            
            // Check if any builds are early_fail
            const earlyFailCount = dataset.data.filter(d => d.status === 'early_fail').length;
            const hasEarlyFail = earlyFailCount > 0;

            stats[dataset.label] = {
                avg: projectedAvg,
                actualAvg: actualAvg,
                min: Math.min(...actualTimes),
                max: Math.max(...actualTimes),
                count: actualTimes.length,
                totalCount: totalCount,
                missingCount: missingCount,
                timedOutCount: timedOutCount,
                hasTimedOut: hasTimedOut,
                earlyFailCount: earlyFailCount,
                hasEarlyFail: hasEarlyFail,
                isProjected: missingCount > 0,
                speedFactor: speedFactor
            };
        });
    }

    return stats;
}

function createChart(datasets, repoName) {
    if (chart) {
        chart.destroy();
    }

    const filteredDatasets = filterData(datasets);

    // Create datasets with single continuous line per platform
    const chartDatasets = [];

    filteredDatasets.forEach(dataset => {
        // Skip disabled platforms
        if (!enabledPlatforms.has(dataset.label)) {
            return;
        }
        
        // Create main dataset with all builds (success + timed_out + early_fail) in one continuous line
        if (dataset.data.length > 0) {
            chartDatasets.push({
                ...dataset,
                showLine: true,
                // Use a function to dynamically set point styles based on data status
                pointStyle: function(context) {
                    const point = context.parsed ? dataset.data[context.dataIndex] : null;
                    if (!point) return 'circle';
                    if (point.status === 'timed_out') return 'triangle';
                    if (point.status === 'early_fail') return 'crossRot';
                    return 'circle';
                },
                pointRadius: function(context) {
                    const point = context.parsed ? dataset.data[context.dataIndex] : null;
                    if (!point) return 4;
                    if (point.status === 'timed_out') return 5;
                    if (point.status === 'early_fail') return 6;
                    return 4;
                }
            });
        }

        // Add failed builds (crosses) - no line connecting them
        if (dataset.failedData && dataset.failedData.length > 0) {
            chartDatasets.push({
                ...dataset,
                data: dataset.failedData,
                pointStyle: 'cross',
                pointRadius: 6,
                pointHoverRadius: 8,
                showLine: false,
                fill: false,
                label: dataset.label + ' (failed)', // Distinguish in legend
                borderColor: dataset.borderColor,
                backgroundColor: dataset.backgroundColor,
                borderWidth: 2
            });
        }
    });

    chart = new Chart(ctx, {
        type: 'line',
        data: { datasets: chartDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                title: {
                    display: true,
                    text: `CI Build Times Over Time - ${repoName}`,
                    font: { size: 18 }
                },
                tooltip: {
                    callbacks: {
                        title: function(context) {
                            const point = context[0];
                            const commit = point.raw.commit_hash.substring(0, 8);
                            return `Commit #${point.parsed.x}: ${commit}`;
                        },
                        label: function(context) {
                            const time = context.parsed.y.toFixed(1);
                            const branch = context.raw.branch_name || 'main';
                            let status = '';
                            if (context.raw.status === 'failure') {
                                status = ' (FAILED)';
                            } else if (context.raw.status === 'early_fail') {
                                status = ' (EARLY FAIL)';
                            } else if (context.raw.status === 'timed_out') {
                                status = ' (TIMED OUT - 2+ HOURS)';
                            }
                            return `${context.dataset.label}: ${time} minutes (branch: ${branch})${status}`;
                        }
                    }
                },
                legend: {
                    display: false // Disable Chart.js legend, we'll create a custom one
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    position: 'bottom',
                    title: {
                        display: true,
                        text: 'Commit Sequence'
                    },
                    grid: {
                        display: true,
                        color: '#e0e0e0'
                    },
                    ticks: {
                        stepSize: 1
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Build Time (minutes)'
                    },
                    beginAtZero: true,
                    grid: {
                        display: true,
                        color: '#e0e0e0'
                    }
                }
            }
        }
    });
    
    // Create custom legend with tooltips
    createCustomLegend(chartDatasets);
}

function createCustomLegend(datasets) {
    // Find or create legend container
    let legendContainer = document.getElementById('customLegend');
    if (!legendContainer) {
        legendContainer = document.createElement('div');
        legendContainer.id = 'customLegend';
        legendContainer.style.display = 'flex';
        legendContainer.style.flexWrap = 'wrap';
        legendContainer.style.justifyContent = 'center';
        legendContainer.style.gap = '15px';
        legendContainer.style.marginBottom = '20px';
        
        // Insert before the chart
        const chartContainer = document.querySelector('.chart-container');
        chartContainer.parentNode.insertBefore(legendContainer, chartContainer);
    }
    
    // Clear existing legend
    legendContainer.innerHTML = '';
    
    // Get unique platforms from the datasets
    const platformsInChart = new Set();
    datasets.forEach(dataset => {
        const platformName = dataset.label.replace(/ \(failed\)$/, '').replace(/ \(timed out\)$/, '');
        platformsInChart.add(platformName);
    });
    
    // Create legend items
    allPlatforms.forEach(platform => {
        if (!platformsInChart.has(platform)) return; // Skip platforms not in current chart
        
        const isEnabled = enabledPlatforms.has(platform);
        
        const legendItem = document.createElement('div');
        legendItem.style.display = 'flex';
        legendItem.style.alignItems = 'center';
        legendItem.style.cursor = 'pointer';
        legendItem.style.opacity = isEnabled ? '1' : '0.4';
        legendItem.setAttribute('data-tooltip', isEnabled ? 'Click to exclude from comparison' : 'Click to include in comparison');
        
        // Color box
        const colorBox = document.createElement('div');
        colorBox.style.width = '12px';
        colorBox.style.height = '12px';
        colorBox.style.backgroundColor = getPlatformColor(platform);
        colorBox.style.marginRight = '8px';
        colorBox.style.borderRadius = '2px';
        
        // Label text
        const labelText = document.createElement('span');
        labelText.textContent = getPlatformDisplayName(platform);
        labelText.style.fontSize = '14px';
        labelText.style.color = '#666';
        
        // Click handler
        legendItem.onclick = () => {
            updatePlatformFilter(platform, !isEnabled);
            // Recreate the legend to update tooltips
            createCustomLegend(datasets);
        };
        
        legendItem.appendChild(colorBox);
        legendItem.appendChild(labelText);
        legendContainer.appendChild(legendItem);
    });
}

function updateStats(datasets) {
    const stats = calculateStats(datasets);
    const statsContainer = document.getElementById('stats');
    statsContainer.innerHTML = '';

    Object.entries(stats).forEach(([platform, stat]) => {
        // Skip disabled platforms
        if (!enabledPlatforms.has(platform)) {
            return;
        }
        
        const color = allDatasets[currentTab].find(d => d.label === platform)?.borderColor || '#666';

        // Determine prefix, asterisk and tooltip text
        let prefix = '';
        let asterisk = '';
        let tooltipText = '';
        
        if (stat.hasEarlyFail || stat.hasTimedOut) {
            prefix = '>';
        }
        
        if (stat.isProjected && stat.hasTimedOut && stat.hasEarlyFail) {
            asterisk = '**';
            tooltipText = `Projected average: ${stat.avg.toFixed(1)}m (actual: ${stat.actualAvg.toFixed(1)}m from ${stat.count} commits, ${stat.missingCount} projected using ${stat.speedFactor.toFixed(2)}x speed factor). Some or all of these builds took longer than 2 hours to complete, and were clipped at 2 hours. Some or all of these runs failed on first error, and so did not do everything other runs did.`;
        } else if (stat.isProjected && stat.hasTimedOut) {
            asterisk = '**';
            tooltipText = `Projected average: ${stat.avg.toFixed(1)}m (actual: ${stat.actualAvg.toFixed(1)}m from ${stat.count} commits, ${stat.missingCount} projected using ${stat.speedFactor.toFixed(2)}x speed factor). Some or all of these builds took longer than 2 hours to complete, and were clipped at 2 hours.`;
        } else if (stat.isProjected && stat.hasEarlyFail) {
            asterisk = '*';
            tooltipText = `Projected average: ${stat.avg.toFixed(1)}m (actual: ${stat.actualAvg.toFixed(1)}m from ${stat.count} commits, ${stat.missingCount} projected using ${stat.speedFactor.toFixed(2)}x speed factor). Some or all of these runs failed on first error, and so did not do everything other runs did.`;
        } else if (stat.isProjected) {
            asterisk = '*';
            tooltipText = `Projected average: ${stat.avg.toFixed(1)}m (actual: ${stat.actualAvg.toFixed(1)}m from ${stat.count} commits, ${stat.missingCount} projected using ${stat.speedFactor.toFixed(2)}x speed factor)`;
        } else if (stat.hasTimedOut && stat.hasEarlyFail) {
            asterisk = '*';
            tooltipText = `Some or all of these builds took longer than 2 hours to complete, and were clipped at 2 hours. Some or all of these runs failed on first error, and so did not do everything other runs did.`;
        } else if (stat.hasTimedOut) {
            asterisk = '*';
            tooltipText = `Some or all of these builds took longer than 2 hours to complete, and were clipped at 2 hours.`;
        } else if (stat.hasEarlyFail) {
            tooltipText = `Some or all of these runs failed on first error, and so did not do everything other runs did.`;
        }

        // Create the div element properly
        const statCard = document.createElement('div');
        statCard.className = 'stat-card';
        if (tooltipText) {
            statCard.setAttribute('data-tooltip', tooltipText);
        }

        statCard.innerHTML = `
            <div class="stat-number" style="color: ${color}">${prefix}${stat.avg.toFixed(1)}m${asterisk}</div>
            <div class="stat-label">${platform}<br>Average Time (${stat.count}/${stat.totalCount || stat.count} commits)</div>
        `;

        statsContainer.appendChild(statCard);
    });
}

function updateChart() {
    if (currentTab >= 0) {
        const filteredDatasets = filterData(allDatasets[currentTab]);

        // Create datasets with single continuous line per platform (same logic as createChart)
        const chartDatasets = [];

        filteredDatasets.forEach(dataset => {
            // Skip disabled platforms
            if (!enabledPlatforms.has(dataset.label)) {
                return;
            }
            
            // Create main dataset with all builds (success + timed_out) in one continuous line
            if (dataset.data.length > 0) {
                chartDatasets.push({
                    ...dataset,
                    showLine: true,
                    // Use a function to dynamically set point styles based on data status
                    pointStyle: function(context) {
                        const point = context.parsed ? dataset.data[context.dataIndex] : null;
                        if (!point) return 'circle';
                        return point.status === 'timed_out' ? 'triangle' : 'circle';
                    },
                    pointRadius: function(context) {
                        const point = context.parsed ? dataset.data[context.dataIndex] : null;
                        if (!point) return 4;
                        return point.status === 'timed_out' ? 5 : 4;
                    }
                });
            }

            // Add failed builds (crosses) - no line connecting them
            if (dataset.failedData && dataset.failedData.length > 0) {
                chartDatasets.push({
                    ...dataset,
                    data: dataset.failedData,
                    pointStyle: 'cross',
                    pointRadius: 6,
                    pointHoverRadius: 8,
                    showLine: false,
                    fill: false,
                    label: dataset.label + ' (failed)', // Distinguish in legend
                    borderColor: dataset.borderColor,
                    backgroundColor: dataset.backgroundColor,
                    borderWidth: 2
                });
            }
        });

        // Update chart data
        chart.data.datasets = chartDatasets;
        chart.update();

        // Update custom legend
        createCustomLegend(chartDatasets);

        // Update statistics
        updateStats(filteredDatasets);
    }
}

function showTab(tabIndex) {
    // Update tab buttons
    document.querySelectorAll('.tab').forEach((tab, index) => {
        tab.classList.toggle('active', index === tabIndex);
    });

    currentTab = tabIndex;

    // Update chart and stats with current filters
    createChart(allDatasets[tabIndex], repoNames[tabIndex]);
    const filteredDatasets = filterData(allDatasets[tabIndex]);
    updateStats(filteredDatasets);
}

// Load data when page loads
loadData();
